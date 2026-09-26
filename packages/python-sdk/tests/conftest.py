import json

import httpx
import pytest

from datool import Datool


@pytest.fixture(autouse=True)
def disable_external_tracing(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")


@pytest.fixture
def recording():
    events = []

    def handle(request):
        assert request.headers["authorization"] == "Bearer test-key"
        assert request.headers["x-project-id"] == "test-project"
        if request.method == "POST":
            event = json.loads(request.content)
            events.append(event)
            return httpx.Response(202, json={"data": {"eventId": event["id"], "status": "queued"}})
        return httpx.Response(200, json={"data": {"status": "saved"}})

    http = httpx.Client(transport=httpx.MockTransport(handle))
    client = Datool(api_key="test-key", project_id="test-project", http_client=http, retries=0)
    yield client, events
    client.shutdown()
    http.close()
