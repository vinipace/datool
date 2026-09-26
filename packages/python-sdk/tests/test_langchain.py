import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from opentelemetry import trace

pytest.importorskip("langgraph")
from langchain_core.documents import Document
from langchain_core.language_models.fake import FakeListLLM
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langchain_core.retrievers import BaseRetriever
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool
from langchain_fixtures import FixtureChatModel, build_model_graph

from datool import DatoolError, propagate_attributes
from datool.langchain import CallbackHandler


def finalized_spans(events):
    starts = {e["body"]["id"]: e["body"] for e in events if e["path"].endswith("/spans")}
    for event in events:
        if event["path"].startswith("/api/spans/"):
            starts[event["path"].split("/")[-1]].update(event["body"])
    return list(starts.values())


@pytest.mark.parametrize("mode", ["sync", "async", "stream", "async-stream"])
def test_chat_model_output_usage_and_masking(recording, mode):
    client, events = recording
    client.mask = lambda value: json.loads(
        json.dumps(value).replace("private-question", "[redacted]")
    )
    handler = CallbackHandler(client=client)
    model = FixtureChatModel()
    config = {"callbacks": [handler]}
    messages = [HumanMessage(content="private-question")]

    async def run():
        if mode == "async-stream":
            return [chunk async for chunk in model.astream(messages, config)]
        return await model.ainvoke(messages, config)

    if mode.startswith("async"):
        result = asyncio.run(run())
    elif mode == "stream":
        result = list(model.stream(messages, config))
    else:
        result = model.invoke(messages, config)
    assert (
        "".join(m.content for m in result) == "It is 22 degrees."
        if isinstance(result, list)
        else result.content == "It is 22 degrees."
    )
    client.flush()
    (span,) = finalized_spans(events)
    assert span["kind"] == "llm"
    assert span["input"] == [[{"role": "user", "content": "[redacted]"}]]
    assert span["output"] == [[{"role": "assistant", "content": "It is 22 degrees."}]]
    assert span["attributes"]["usage.total_tokens"] == 14
    assert span["attributes"]["model"] == "fixture-weather"
    assert "cost.usd" not in span["attributes"]
    assert not handler._runs and not client.processor.traces


@pytest.mark.parametrize("asynchronous", [False, True])
def test_graph_callbacks_capture_nested_tool_and_model(recording, asynchronous):
    client, events = recording
    handler = CallbackHandler(client=client)
    graph = build_model_graph()
    if asynchronous:
        result = asyncio.run(
            graph.ainvoke(
                {"messages": [HumanMessage(content="Weather?")]}, {"callbacks": [handler]}
            )
        )
    else:
        result = graph.invoke(
            {"messages": [HumanMessage(content="Weather?")]}, {"callbacks": [handler]}
        )
    assert result["messages"][-1].content == "It is 22 degrees."
    client.flush()
    spans = {s["name"]: s for s in finalized_spans(events)}
    assert len(spans) == 4
    assert spans["lookup"]["kind"] == "task"
    assert spans["answer"]["kind"] == "task"
    assert spans["weather"]["kind"] == "tool"
    assert spans["weather"]["parentId"] == spans["lookup"]["id"]
    assert spans["FixtureChatModel"]["parentId"] == spans["answer"]["id"]
    assert spans["FixtureChatModel"]["kind"] == "llm"
    root = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert root["attributes"]["usage.total_tokens"] == 14
    assert root["attributes"]["datool.span.kind"] == "workflow"
    assert root["output"]["messages"][-1]["role"] == "assistant"
    assert not handler._runs


@pytest.mark.parametrize("root_type", [None, "agent", "workflow", "chain"])
def test_root_type_does_not_leak_to_helpers_or_models(recording, root_type):
    client, events = recording
    handler = CallbackHandler(client=client, root_type=root_type)
    # A helper name containing 'agent' is not sufficient evidence of an agent.
    helper = RunnableLambda(lambda value: value).with_config(run_name="prepare_agent_prompt")
    chain = helper | FixtureChatModel()
    chain.invoke("Weather?", {"callbacks": [handler]})
    client.flush()
    spans = finalized_spans(events)
    assert {s["name"]: s["kind"] for s in spans} == {
        "prepare_agent_prompt": "function",
        "FixtureChatModel": "llm",
    }
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert final["attributes"]["datool.span.kind"] == (
        root_type if root_type in {"agent", "workflow"} else "function"
    )
    assert not handler._runs and not handler._run_metadata


def test_serialized_agent_class_is_recognized_with_custom_name(recording):
    client, events = recording
    handler = CallbackHandler(client=client)
    with client.start_as_current_observation(name="request"):
        run_id = uuid4()
        handler.on_chain_start(
            {"id": ["langchain", "agents", "AgentExecutor"]},
            {},
            run_id=run_id,
            name="weather-helper",
        )
        handler.on_chain_end({}, run_id=run_id)
    client.flush()
    (span,) = finalized_spans(events)
    assert span["kind"] == "agent"
    assert "group" not in span
    assert not handler._run_metadata


def test_invalid_root_type_fails_before_recording(recording):
    client, events = recording
    with pytest.raises(ValueError, match="root_type"):
        CallbackHandler(client=client, root_type="llm")
    assert not events


def test_shared_handler_concurrent_runs_and_manual_parent(recording):
    client, events = recording
    handler = CallbackHandler(client=client)
    chain = RunnableLambda(lambda value: {"value": value})

    def run(value):
        with propagate_attributes(user_id=str(value)):
            with client.start_as_current_observation(name=f"request-{value}") as root:
                chain.invoke(value, {"callbacks": [handler]})
                assert trace.get_current_span() is root.span
                return root.trace_id

    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(run, range(12)))
    assert len(set(ids)) == 12
    client.flush()
    spans = finalized_spans(events)
    assert len(spans) == 12
    assert {s["output"]["value"] for s in spans} == set(range(12))
    assert all(s["attributes"]["user.id"] == str(s["output"]["value"]) for s in spans)
    assert not handler._runs and not client.processor.traces
    assert not trace.get_current_span().get_span_context().is_valid


def test_shared_handler_async_runs_are_isolated(recording):
    client, events = recording
    handler = CallbackHandler(client=client)

    async def identity(value):
        await asyncio.sleep(0)
        return value

    chain = RunnableLambda(identity)

    async def run():
        return await asyncio.gather(
            *(chain.ainvoke(i, {"callbacks": [handler]}) for i in range(12))
        )

    assert asyncio.run(run()) == list(range(12))
    client.flush()
    roots = [e["body"]["id"] for e in events if e["path"] == "/api/traces"]
    assert len(set(roots)) == 12
    assert {
        e["body"]["output"] for e in events if e["path"] in {f"/api/traces/{r}" for r in roots}
    } == set(range(12))
    assert not handler._runs


@pytest.mark.parametrize("asynchronous", [False, True])
def test_closed_model_stream_records_cancellation(recording, asynchronous):
    client, events = recording
    handler = CallbackHandler(client=client)
    model = FixtureChatModel()

    async def run():
        stream = model.astream("Question", {"callbacks": [handler]})
        await anext(stream)
        await stream.aclose()

    if asynchronous:
        asyncio.run(run())
    else:
        stream = model.stream("Question", {"callbacks": [handler]})
        next(stream)
        stream.close()
    client.flush()
    assert finalized_spans(events)[0]["status"] == "cancelled"
    assert not handler._runs and not client.processor.traces


def test_retriever_and_text_model(recording):
    class Retriever(BaseRetriever):
        def _get_relevant_documents(self, query, *, run_manager):
            return [Document(page_content="22 degrees", metadata={"city": query})]

    client, events = recording
    handler = CallbackHandler(client=client)
    with client.start_as_current_observation(name="chain"):
        docs = Retriever().invoke("São Paulo", {"callbacks": [handler]})
        assert (
            FakeListLLM(responses=["warm"]).invoke(docs[0].page_content, {"callbacks": [handler]})
            == "warm"
        )
    client.flush()
    spans = finalized_spans(events)
    assert spans[0]["output"] == [{"page_content": "22 degrees", "metadata": {"city": "São Paulo"}}]
    assert spans[1]["kind"] == "llm" and spans[1]["output"] == [["warm"]]
    assert "usage.total_tokens" not in spans[1]["attributes"]


@pytest.mark.parametrize("component", ["model", "tool", "retriever"])
def test_component_errors_keep_original_exception(recording, component):
    client, events = recording
    handler = CallbackHandler(client=client)

    @tool
    def fail(value: str) -> str:
        """Raise the fixture failure."""
        raise ValueError("private-provider-error")

    class FailingRetriever(BaseRetriever):
        def _get_relevant_documents(self, query, *, run_manager):
            raise ValueError("private-provider-error")

    runnable = {
        "model": FixtureChatModel(fail=True),
        "tool": fail,
        "retriever": FailingRetriever(),
    }[component]
    with pytest.raises(ValueError, match="private-provider-error"):
        runnable.invoke("question", {"callbacks": [handler]})
    client.flush()
    assert "private-provider-error" not in json.dumps(events)
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert final["status"] == "errored"
    assert not handler._runs and not client.processor.traces


def test_provider_usage_not_counted_twice_and_tool_calls_preserved(recording):
    client, events = recording
    handler = CallbackHandler(client=client)
    run_id = uuid4()
    handler.on_chat_model_start(
        {"id": ["FixtureModel"], "kwargs": {"api_key": "private-key"}},
        [[HumanMessage(content="Hello")]],
        run_id=run_id,
    )
    handler.on_llm_end(
        LLMResult(
            generations=[
                [
                    ChatGeneration(
                        message=AIMessage(
                            content="",
                            tool_calls=[
                                {"name": "weather", "args": {"city": "London"}, "id": "call-1"}
                            ],
                            usage_metadata={
                                "input_tokens": 10,
                                "output_tokens": 4,
                                "total_tokens": 14,
                            },
                        )
                    )
                ]
            ],
            llm_output={
                "model_name": "fixture",
                "token_usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            },
        ),
        run_id=run_id,
    )
    # A repeated end event cannot complete/export twice.
    handler.on_llm_error(ValueError("ignored"), run_id=run_id)
    client.flush()
    (span,) = finalized_spans(events)
    assert span["attributes"]["usage.total_tokens"] == 14
    assert span["output"][0][0]["tool_calls"][0]["name"] == "weather"
    assert "private-key" not in json.dumps(events)


def test_callback_recording_failure_surfaces_at_flush(recording):
    client, events = recording
    handler = CallbackHandler(client=client)

    def fail_mask(value):
        raise ValueError("private-mask-error")

    client.mask = fail_mask
    assert RunnableLambda(lambda x: x).invoke(1, {"callbacks": [handler]}) == 1
    with pytest.raises(DatoolError, match="callback start failed"):
        client.flush()
    # Clear the intentionally injected recording failure for fixture teardown.
    client.processor.failure = None
    assert not handler._runs and not client.processor.traces


def test_cancelled_async_run_keeps_cancellation_and_cleans_up(recording):
    client, events = recording
    handler = CallbackHandler(client=client)

    async def run():
        started = asyncio.Event()

        async def blocked(value):
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(RunnableLambda(blocked).ainvoke(1, {"callbacks": [handler]}))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    client.flush()
    final = [e["body"] for e in events if e["path"] == f"/api/traces/{handler.last_trace_id}"][-1]
    assert final["status"] == "cancelled"
    assert not handler._runs and not client.processor.traces
