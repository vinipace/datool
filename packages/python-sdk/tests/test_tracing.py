import asyncio
import concurrent.futures
import json

import pytest
from opentelemetry import trace

from datool import propagate_attributes


def final_traces(events):
    return [
        e["body"] for e in events if e["method"] == "PATCH" and e["path"].startswith("/api/traces/")
    ]


def test_nesting_usage_groups_and_durable_order(recording):
    client, events = recording
    with propagate_attributes(session_id="session-1", user_id="user-1"):
        with client.start_as_current_observation(
            name="workflow", as_type="workflow", group={"type": "workflow", "name": "answer"}
        ) as root:
            with client.start_as_current_observation(name="agent", as_type="agent") as agent:
                with client.start_as_current_observation(
                    name="llm", as_type="generation", model="test-model"
                ) as llm:
                    llm.update(
                        input={"query": "hello"},
                        output="answer",
                        usage_details={"input": 10, "output": 3},
                        cost_details={"total": 0.002},
                    )
                with client.start_as_current_observation(name="tool", as_type="tool"):
                    pass
            root.update(output={"ok": True})
    client.flush()
    assert events[0]["path"] == "/api/traces"
    for previous, event in zip(events, events[1:], strict=False):
        assert event["previousId"] == previous["id"]
    starts = [e["body"] for e in events if e["path"].endswith("/spans")]
    assert starts[0]["id"] == agent.id and starts[0]["parentId"] is None
    assert starts[1]["id"] == llm.id and starts[1]["parentId"] == agent.id
    assert all("group" not in s for s in starts)
    root_start = next(e["body"] for e in events if e["path"] == "/api/traces")
    assert root_start["group"] == {"type": "workflow", "name": "answer"}
    final = final_traces(events)[0]
    assert final["status"] == "completed" and final["output"] == {"ok": True}
    assert final["attributes"]["usage.total_tokens"] == 13
    assert final["attributes"]["cost.usd"] == 0.002
    assert final["attributes"]["user.id"] == "user-1"
    assert not trace.get_current_span().get_span_context().is_valid


def test_sync_decorator_preserves_identity_errors_and_methods(recording):
    client, events = recording
    value = object()

    class Example:
        @client.observe()
        def run(self, arg):
            return arg

    @client.observe()
    def fail():
        raise ValueError("secret-value")

    assert Example().run(value) is value
    with pytest.raises(ValueError, match="secret-value"):
        fail()
    client.flush()
    assert final_traces(events)[0]["input"] == {"arg": "<object>"}
    assert final_traces(events)[1]["status"] == "errored"
    assert "secret-value" not in json.dumps(events)


def test_async_concurrency_has_isolated_parent_and_session(recording):
    client, events = recording

    @client.observe(as_type="tool")
    async def child(value):
        await asyncio.sleep(0)
        return value

    async def branch(number):
        with propagate_attributes(session_id=f"session-{number}"):
            with client.start_as_current_observation(name=f"root-{number}"):
                await child(number)

    async def run():
        await asyncio.gather(*(branch(i) for i in range(15)))
        await client.aflush()

    asyncio.run(run())
    roots = {e["body"]["id"]: e["body"]["sessionId"] for e in events if e["path"] == "/api/traces"}
    assert len(roots) == 15
    for event in events:
        if event["path"].endswith("/spans"):
            tid = event["path"].split("/")[3]
            assert event["body"]["attributes"]["session.id"] == roots[tid]


def test_generator_protocol_context_and_return_value(recording):
    client, events = recording

    @client.observe()
    def generate():
        received = yield "first"
        try:
            yield received
        except ValueError:
            yield "recovered"
        return 42

    stream = generate()
    assert events == []
    assert next(stream) == "first"
    assert not trace.get_current_span().get_span_context().is_valid
    assert stream.send("second") == "second"
    assert stream.throw(ValueError("expected")) == "recovered"
    with pytest.raises(StopIteration) as stopped:
        next(stream)
    assert stopped.value.value == 42
    client.flush()
    assert final_traces(events)[0]["output"] == "firstsecondrecovered"


def test_generator_cancellation_and_unstarted_close(recording):
    client, events = recording
    closed = []

    @client.observe()
    def generate():
        try:
            yield "first"
            yield "second"
        finally:
            closed.append(True)

    unopened = generate()
    unopened.close()
    assert events == []
    stream = generate()
    next(stream)
    stream.close()
    client.flush()
    assert closed == [True]
    assert final_traces(events)[0]["status"] == "cancelled"


def test_async_generator_protocol_and_close(recording):
    client, events = recording

    @client.observe()
    async def generate():
        received = yield "first"
        try:
            yield received
        except ValueError:
            yield "recovered"

    async def run():
        stream = generate()
        assert await stream.__anext__() == "first"
        assert not trace.get_current_span().get_span_context().is_valid
        assert await stream.asend("second") == "second"
        assert await stream.athrow(ValueError()) == "recovered"
        await stream.aclose()
        await client.aflush()

    asyncio.run(run())
    assert final_traces(events)[0]["status"] == "cancelled"


def test_async_task_cancellation_is_not_an_error(recording):
    client, events = recording

    @client.observe()
    async def cancelled():
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(cancelled())
    client.flush()
    assert final_traces(events)[0]["status"] == "cancelled"


def test_manual_child_and_root_ending_before_child(recording):
    client, events = recording
    root = client.start_observation(name="manual")
    child = root.start_observation(name="child")
    assert not trace.get_current_span().get_span_context().is_valid
    root.end()
    client.flush()
    assert final_traces(events) == []
    child.update(output=None)
    child.end()
    client.flush()
    assert len(final_traces(events)) == 1


def test_external_otel_instrumentation_and_missing_metrics(recording):
    client, events = recording
    with client.start_as_current_observation(name="native"):
        with client.provider.get_tracer("external").start_as_current_span(
            "model",
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "test",
                "gen_ai.usage.input_tokens": 0,
            },
        ):
            pass
    client.flush()
    final = final_traces(events)[0]["attributes"]
    assert final["usage.input_tokens"] == 0
    assert "usage.output_tokens" not in final and "cost.usd" not in final
    assert final["cost.status"] == "missing"


def test_opt_out_and_bounded_recording(recording):
    client, events = recording
    client.max_io_characters = 10

    @client.observe(capture_input=False, capture_output=False)
    def hidden(value):
        return value

    assert hidden("secret") == "secret"
    with client.start_as_current_observation(name="bounded", input="x" * 500):
        pass
    client.flush()
    assert "secret" not in json.dumps(events)
    assert "truncated" in final_traces(events)[1]["input"]


def test_threads_export_without_corrupting_event_chain(recording):
    client, events = recording

    @client.observe()
    def run(number):
        return number * 2

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(run, range(40))) == [n * 2 for n in range(40)]
    client.flush()
    assert len(final_traces(events)) == 40
    assert all(b["previousId"] == a["id"] for a, b in zip(events, events[1:], strict=False))


@pytest.mark.parametrize("asynchronous", [False, True])
def test_stream_preserves_propagated_attributes_without_leaking_to_consumer(
    recording, asynchronous
):
    client, events = recording

    @client.observe()
    def sync_stream():
        with propagate_attributes(user_id="producer"):
            yield "chunk"
            with client.start_as_current_observation(name="producer-child"):
                pass

    @client.observe()
    async def async_stream():
        with propagate_attributes(user_id="producer"):
            yield "chunk"
            with client.start_as_current_observation(name="producer-child"):
                pass

    with propagate_attributes(user_id="creation"):
        stream = async_stream() if asynchronous else sync_stream()

    async def consume():
        with propagate_attributes(user_id="consumer"):
            if asynchronous:
                assert await stream.__anext__() == "chunk"
            else:
                assert next(stream) == "chunk"
            with client.start_as_current_observation(name="consumer"):
                pass
            if asynchronous:
                with pytest.raises(StopAsyncIteration):
                    await stream.__anext__()
            else:
                with pytest.raises(StopIteration):
                    next(stream)

    asyncio.run(consume())
    client.flush()
    roots = [e["body"] for e in events if e["path"] == "/api/traces"]
    assert roots[0]["attributes"]["user.id"] == "creation"
    assert roots[1]["attributes"]["user.id"] == "consumer"
    child = next(e["body"] for e in events if e["path"].endswith("/spans"))
    assert child["attributes"]["user.id"] == "producer"
