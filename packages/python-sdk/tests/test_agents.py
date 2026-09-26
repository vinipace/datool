import asyncio
import importlib
import sys
from pathlib import Path

import pytest

pytest.importorskip("langchain", reason="Install the agents dependency group to run these tests")

from datool.langchain import CallbackHandler


@pytest.fixture
def agent_examples(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "examples"))
    return importlib.import_module("datool_agent_demo"), importlib.import_module("react_agent")


def make_agent(kind, examples, *, fail=False):
    demo, react = examples
    if kind == "deep":
        pytest.importorskip("deepagents", reason="Deep Agents requires Python 3.11+")
        return importlib.import_module("deep_agent").build_agent(
            model=demo.DemoAgentModel(fail=True) if fail else None
        )
    return react.build_agent(model=demo.DemoAgentModel(fail=fail), legacy=kind == "react")


def require_async_callbacks(kind):
    if kind == "agent" and sys.version_info < (3, 11):
        pytest.skip("Upstream create_agent async model callbacks require Python 3.11+")


def spans_for(events, trace_id):
    spans = {
        e["body"]["id"]: dict(e["body"])
        for e in events
        if e["path"] == f"/api/traces/{trace_id}/spans"
    }
    for event in events:
        span_id = event["path"].removeprefix("/api/spans/")
        if span_id in spans:
            spans[span_id].update(event["body"])
    return spans


@pytest.mark.parametrize("kind", ["react", "agent", "deep"])
@pytest.mark.parametrize("mode", ["sync", "async", "stream", "async-stream"])
def test_agent_examples_capture_real_tool_loops(recording, agent_examples, kind, mode):
    if mode.startswith("async"):
        require_async_callbacks(kind)
    client, events = recording
    demo, _ = agent_examples
    report = asyncio.run(
        demo.run_agent(make_agent(kind, agent_examples), client, name=f"{kind}-test", mode=mode)
    )
    assert report["answer"] == "São Paulo: 22°C; sunny."
    spans = spans_for(events, report["trace_id"])
    models = [s for s in spans.values() if s["kind"] == "llm"]
    tools = [s for s in spans.values() if s["kind"] == "tool"]
    assert len(models) == (6 if kind == "deep" else 2)
    assert {s["name"] for s in tools} == (
        {"write_todos", "task", "weather"} if kind == "deep" else {"weather"}
    )
    weather = next(s for s in tools if s["name"] == "weather")
    assert weather["input"] == {"city": "São Paulo"}
    assert weather["output"]["content"] == "São Paulo: 22°C; sunny."
    assert all(s["status"] == "completed" for s in spans.values())
    assert all(s["parentId"] is None or s["parentId"] in spans for s in spans.values())
    assert all(s["attributes"]["model"] == "datool-demo-agent" for s in models)
    assert any(s["kind"] == "task" and s["name"] == "tools" for s in spans.values())
    if kind == "react":
        assert all(s["kind"] == "agent" for s in spans.values() if s["name"] == "agent")
        assert all(
            s["kind"] == "function"
            for s in spans.values()
            if s["name"] in {"Prompt", "call_model", "RunnableSequence", "should_continue"}
        )
    if kind == "deep":
        specialist = next(s for s in spans.values() if s["name"] == "weather-expert")
        assert specialist["kind"] == "agent"
        assert all(
            s["kind"] == "task"
            for s in spans.values()
            if s["name"] == "PatchToolCallsMiddleware.before_agent"
        )
        assert any(
            call["name"] == "write_todos"
            for model in models
            for group in model["output"]
            for message in group
            for call in message.get("tool_calls", [])
        )
        plans = [s for s in tools if s["name"] == "write_todos"]
        assert len(plans) == 2
        assert plans[-1]["output"]["update"]["todos"][0]["status"] == "completed"
        assert plans[-1]["output"]["update"]["messages"][0]["role"] == "tool"
        task = next(s for s in tools if s["name"] == "task")
        parent = weather["parentId"]
        ancestors = set()
        while parent:
            ancestors.add(parent)
            parent = spans[parent]["parentId"]
        assert task["id"] in ancestors
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{report['trace_id']}"][-1]
    assert final["attributes"]["usage.llm_calls"] == len(models)
    assert final["attributes"]["datool.span.kind"] == "agent"
    assert final["attributes"]["usage.status"] == "missing"
    assert final["output"]["messages"][-1]["content"] == report["answer"]
    if kind == "deep":
        assert final["output"]["todos"] == [
            {"content": "Ask the weather expert", "status": "completed"}
        ]
    assert not client.processor.traces


@pytest.mark.parametrize("kind", ["react", "agent", "deep"])
@pytest.mark.parametrize("asynchronous", [False, True])
def test_agent_model_errors_close_callback_observations(
    recording, agent_examples, kind, asynchronous
):
    if asynchronous:
        require_async_callbacks(kind)
    client, events = recording
    agent = make_agent(kind, agent_examples, fail=True)
    handler = CallbackHandler(client=client)
    inputs = {"messages": [{"role": "user", "content": "Weather?"}]}
    config = {"callbacks": [handler]}
    with pytest.raises(ValueError, match="demo provider failure"):
        if asynchronous:
            asyncio.run(agent.ainvoke(inputs, config))
        else:
            agent.invoke(inputs, config)
    client.flush()
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert final["status"] == "errored"
    assert not handler._runs and not client.processor.traces


@pytest.mark.parametrize("kind", ["react", "agent", "deep"])
def test_agents_share_a_callback_without_crossing_request_traces(recording, agent_examples, kind):
    require_async_callbacks(kind)
    client, events = recording
    handler = CallbackHandler(client=client)
    agent = make_agent(kind, agent_examples)

    async def run():
        return await asyncio.gather(
            *(
                agent.ainvoke(
                    {"messages": [{"role": "user", "content": f"Weather request {i}"}]},
                    {"callbacks": [handler], "metadata": {"request_number": i}},
                )
                for i in range(2)
            )
        )

    results = asyncio.run(run())
    assert all(r["messages"][-1].content == "São Paulo: 22°C; sunny." for r in results)
    client.flush()
    roots = [e["body"]["id"] for e in events if e["path"] == "/api/traces"]
    assert len(set(roots)) == 2
    for root in roots:
        final = [e["body"] for e in events if e["path"] == f"/api/traces/{root}"][-1]
        spans = spans_for(events, root)
        # No root_type hint: modern factories identify themselves; legacy ReAct
        # only identifies a generic graph, with an agent-typed node inside it.
        assert final["attributes"]["datool.span.kind"] == (
            "workflow" if kind == "react" else "agent"
        )
        assert sum(s["kind"] == "llm" for s in spans.values()) == (6 if kind == "deep" else 2)
        assert all(s["parentId"] is None or s["parentId"] in spans for s in spans.values())
        assert all(
            s["attributes"]["metadata.request_number"]
            == final["attributes"]["metadata.request_number"]
            for s in spans.values()
        )
    assert not handler._runs and not handler._run_metadata and not client.processor.traces
