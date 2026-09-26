import json
import threading
import time

import httpx
import pytest

from datool import Datool, DatoolError, DatoolHTTPError


def make_client(handler, **kwargs):
    return Datool(
        api_key="secret",
        project_id="project",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        **kwargs,
    )


def test_retries_preserve_exact_event_and_wait_for_receipt():
    bodies = []
    receipts = []

    def handler(request):
        if request.method == "POST":
            bodies.append(request.content)
            return httpx.Response(503 if len(bodies) == 1 else 202, json={"data": {}})
        receipts.append(True)
        return httpx.Response(
            200, json={"data": {"status": "waiting" if len(receipts) < 3 else "saved"}}
        )

    client = make_client(handler, retries=1)
    with client.start_as_current_observation(name="retry"):
        pass
    client.flush()
    assert bodies[0] == bodies[1]
    assert len(receipts) == 3
    client.shutdown()


def test_failed_export_is_retained_and_next_flush_recovers():
    available = False
    bodies = []

    def handler(request):
        if request.method == "POST":
            bodies.append(request.content)
            return httpx.Response(202 if available else 503, json={"data": {}})
        return httpx.Response(200, json={"data": {"status": "saved"}})

    client = make_client(handler, retries=0)
    with client.start_as_current_observation(name="outage"):
        pass
    with pytest.raises(DatoolError, match="retained"):
        client.shutdown()
    assert not client.closed
    available = True
    client.flush()
    assert bodies[0] == bodies[-2]
    client.shutdown()


@pytest.mark.parametrize("status", ["failed", "waiting"])
def test_http_202_is_not_persistence_proof(status):
    state = status

    def handler(request):
        return httpx.Response(
            202 if request.method == "POST" else 200, json={"data": {"status": state}}
        )

    client = make_client(handler, retries=0)
    with client.start_as_current_observation(name="pending"):
        pass
    with pytest.raises(DatoolError):
        client.flush(timeout=0.1)
    state = "saved"
    client.shutdown()


def test_error_sanitization_redirect_rejection_and_mutation_no_retry():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, text="secret-token")

    client = make_client(handler, retries=3)
    with pytest.raises(DatoolHTTPError) as error:
        client.request("/api/datasets", "POST", {"name": "test"})
    assert error.value.status_code == 503
    assert "secret" not in str(error.value) and len(requests) == 1
    for path in [
        "https://evil.test/api/x",
        "//evil.test/api/x",
        "/api/../x",
        "/api/%2e%2e/x",
        "/api/\\evil",
    ]:
        with pytest.raises(ValueError):
            client.request(path)
    client.shutdown()

    redirect = make_client(
        lambda request: httpx.Response(302, headers={"location": "https://evil.test"})
    )
    with pytest.raises(DatoolHTTPError, match="302"):
        redirect.request("/api/traces")
    redirect.shutdown()


def test_queue_overflow_is_visible_at_flush_and_does_not_block_application():
    entered, release = threading.Event(), threading.Event()

    def handler(request):
        entered.set()
        release.wait(2)
        return httpx.Response(200, json={"data": {"status": "saved"}})

    client = make_client(handler, max_queue_size=1)
    root = client.start_observation(name="overflow")
    assert entered.wait(1)
    root.end()
    with pytest.raises(DatoolError, match="queue is full"):
        client.flush()
    release.set()
    # An overflow is intentionally sticky; explicitly dispose this fault-injection fixture.
    with client.processor.transport.cv:
        client.processor.transport.stopped = True
        client.processor.transport.cv.notify_all()
    client.processor.transport.worker.join(2)


def test_flush_has_a_snapshot_barrier(recording):
    client, events = recording
    with client.start_as_current_observation(name="first"):
        pass
    client.flush()
    assert len(events) == 2
    assert json.loads(json.dumps(events)) == events


def test_invalid_envelopes_and_json_are_rejected():
    for response in [httpx.Response(200, text="invalid"), httpx.Response(200, json={"wrong": []})]:
        client = make_client(lambda request, response=response: response, retries=0)
        with pytest.raises(DatoolError):
            client.request("/api/traces")
        client.shutdown()


def test_network_failure_does_not_leak_request_details():
    def handler(request):
        raise httpx.ConnectError("secret-key-and-url", request=request)

    client = make_client(handler, retries=0)
    with pytest.raises(DatoolError) as error:
        client.request("/api/traces")
    assert "secret" not in str(error.value)
    client.shutdown()


def test_flush_timeout_is_bounded():
    client = make_client(lambda request: httpx.Response(503), retries=20)
    started = time.monotonic()
    with pytest.raises(DatoolError):
        client.processor.transport.request("/api/ingest?eventId=x", deadline=started + 0.05)
    assert time.monotonic() - started < 0.5
    client.shutdown()
