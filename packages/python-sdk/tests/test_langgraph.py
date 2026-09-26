import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest
from opentelemetry import trace

pytest.importorskip("langgraph", reason="Install the langgraph dependency group to run these tests")
path = Path(__file__).resolve().parents[1] / "examples" / "langgraph_weather.py"
spec = importlib.util.spec_from_file_location("datool_langgraph_example", path)
example = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = example
spec.loader.exec_module(example)


@pytest.mark.parametrize("mode", ["sync", "async", "stream", "async-stream"])
def test_real_langgraph_nodes_share_the_workflow_trace(recording, mode):
    client, events = recording
    if mode.startswith("async"):
        report = asyncio.run(example.run_async(client, stream=mode == "async-stream"))
    else:
        report = example.run_sync(client, stream=mode == "stream")
    assert report["result"]["answer"] == "São Paulo: 22°C; visit a park."
    roots = [e["body"] for e in events if e["path"] == "/api/traces"]
    assert len(roots) == 1 and roots[0]["id"] == report["trace_id"]
    starts = [e for e in events if e["path"].endswith("/spans")]
    assert len(starts) == 5
    assert {e["body"]["name"] for e in starts} == {
        "lookup-weather",
        "suggest-activity",
        "compose_answer",
        "lookup_weather",
        "suggest_activity",
    }
    assert all(e["path"] == f"/api/traces/{report['trace_id']}/spans" for e in starts)
    nodes = {e["body"]["name"]: e["body"] for e in starts}
    assert all(
        nodes[name]["parentId"] is None
        for name in ("lookup_weather", "suggest_activity", "compose_answer")
    )
    assert nodes["lookup-weather"]["parentId"] == nodes["lookup_weather"]["id"]
    assert nodes["suggest-activity"]["parentId"] == nodes["suggest_activity"]["id"]
    assert nodes["lookup-weather"]["kind"] == nodes["suggest-activity"]["kind"] == "tool"
    completed = [e for e in events if e["path"].startswith("/api/spans/")]
    assert all(e["body"]["attributes"]["metadata.framework"] == "langgraph" for e in completed)
    final = [e for e in events if e["path"] == f"/api/traces/{report['trace_id']}"][-1]["body"]
    assert final["status"] == "completed" and final["output"] == report["result"]
    assert not trace.get_current_span().get_span_context().is_valid


def test_concurrent_langgraph_runs_do_not_mix_traces(recording):
    client, events = recording

    async def concurrent():
        return await asyncio.gather(
            example.run_async(client, "São Paulo"), example.run_async(client, "London")
        )

    reports = asyncio.run(concurrent())
    assert len({r["trace_id"] for r in reports}) == 2
    for report in reports:
        finalized = [e["body"] for e in events if e["path"] == f"/api/traces/{report['trace_id']}"][
            -1
        ]
        assert finalized["output"]["city"] == report["result"]["city"]
        node_ids = {
            e["body"]["id"]
            for e in events
            if e["path"] == f"/api/traces/{report['trace_id']}/spans"
        }
        outputs = [
            e["body"]["output"]
            for e in events
            if e["path"].split("/")[-1] in node_ids and "output" in e["body"]
        ]
        assert {"answer": report["result"]["answer"]} in outputs


@pytest.mark.parametrize("asynchronous", [False, True])
def test_langgraph_node_error_keeps_original_exception_and_closes_spans(recording, asynchronous):
    client, events = recording
    with pytest.raises(ValueError, match="No fixture weather"):
        if asynchronous:
            asyncio.run(example.run_async(client, "Unknown"))
        else:
            example.run_sync(client, "Unknown")
    client.flush()
    final = [
        e["body"] for e in events if e["method"] == "PATCH" and e["path"].startswith("/api/traces/")
    ]
    assert len(final) == 1 and final[0]["status"] == "errored"
    assert not client.processor.traces


@pytest.mark.parametrize("asynchronous", [False, True])
def test_closing_partial_graph_stream_cleans_up_callbacks(recording, asynchronous):
    from datool.langchain import CallbackHandler

    client, events = recording
    handler = CallbackHandler(client=client)
    graph = example.build_graph(async_nodes=asynchronous)

    async def consume():
        stream = graph.astream(
            {"city": "São Paulo"}, {"callbacks": [handler]}, stream_mode="values"
        )
        await anext(stream)
        await stream.aclose()

    if asynchronous:
        asyncio.run(consume())
    else:
        stream = graph.stream({"city": "São Paulo"}, {"callbacks": [handler]}, stream_mode="values")
        next(stream)
        stream.close()
    client.flush()
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert final["status"] == "cancelled"
    assert not handler._runs and not client.processor.traces


def test_nested_graph_preserves_callback_parentage(recording):
    from langgraph.graph import END, START, StateGraph

    from datool.langchain import CallbackHandler

    client, events = recording
    handler = CallbackHandler(client=client)
    builder = StateGraph(example.WeatherState)
    builder.add_node("weather_subgraph", example.build_graph())
    builder.add_edge(START, "weather_subgraph")
    builder.add_edge("weather_subgraph", END)
    result = builder.compile().invoke({"city": "London"}, {"callbacks": [handler]})
    assert result["answer"] == "London: 15°C; visit a museum."
    client.flush()
    starts = [e["body"] for e in events if e["path"].endswith("/spans")]
    by_id = {span["id"]: span for span in starts}
    assert len(starts) >= 6
    for name in ("lookup_weather", "suggest_activity", "compose_answer"):
        node = next(span for span in starts if span["name"] == name)
        assert node["parentId"] in by_id
    assert len([e for e in events if e["path"] == "/api/traces"]) == 1
    assert not handler._runs
