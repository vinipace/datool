"""Runs ONLY from the disposable integration harness, against the installed wheel."""

import asyncio
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from langchain_core.messages import HumanMessage
from langchain_fixtures import build_model_graph

from datool import Datool, DatoolError, DatoolHTTPError, propagate_attributes
from datool.langchain import CallbackHandler

client = Datool()
session = client.request("/api/sessions", "POST", {"name": "Python acceptance"})
prompt = client.request(
    "/api/prompts",
    "POST",
    {
        "name": "Python prompt",
        "slug": "python-answer",
        "model": "openai/gpt-4.1-mini",
        "provider": "vercel-ai-gateway",
        "messages": [{"role": "user", "content": "Weather in {{city}}?"}],
    },
)
client.request(
    f"/api/prompts/{prompt['id']}/publish", "POST", {"expectedRevision": prompt["revision"]}
)
published = client.prompts.get("python-answer")
assert published.render({"city": "São Paulo"}) == [
    {"role": "user", "content": "Weather in São Paulo?"}
]

with propagate_attributes(session_id=session["id"], user_id="python-user"):
    with client.start_as_current_observation(
        name="python-root",
        as_type="workflow",
        group={"type": "workflow", "name": "python-assistant", "version": "v1"},
    ) as root:
        with client.start_as_current_observation(name="assistant", as_type="agent") as agent:
            with client.start_as_current_observation(
                name="generation", as_type="generation", model="test-model"
            ) as generation:
                generation.update(
                    input=published.render({"city": "São Paulo"}),
                    output="22 degrees",
                    usage_details={"input": 10, "output": 3},
                    cost_details={"total": 0.002},
                )
            with client.provider.get_tracer("external-library").start_as_current_span(
                "external-tool",
                attributes={
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.call.arguments": '{"city":"São Paulo"}',
                },
            ):
                pass
        root.update(output={"answer": "22 degrees"})


@client.observe(as_type="tool")
async def tool(number):
    await asyncio.sleep(0)
    return number


async def branch(number):
    with propagate_attributes(session_id=session["id"]):
        with client.start_as_current_observation(name=f"async-{number}"):
            assert await tool(number) == number


async def concurrent():
    await asyncio.gather(*(branch(i) for i in range(3)))
    await client.aflush()


asyncio.run(concurrent())


@client.observe()
def stream():
    yield "hello"
    yield " world"


assert list(stream()) == ["hello", " world"]
partial = stream()
assert next(partial) == "hello"
partial.close()


@client.observe()
async def async_stream():
    yield "async"


async def consume():
    assert [chunk async for chunk in async_stream()] == ["async"]


asyncio.run(consume())


@client.observe()
def failure():
    raise ValueError("application failure remains visible")


try:
    failure()
except ValueError:
    pass
else:
    raise AssertionError("Decorator swallowed the application error")
client.flush()

# HTTP 202 while the worker is paused must NOT satisfy flush.
client.request("/api/test/worker", "POST", {"paused": True})
with client.start_as_current_observation(name="worker-recovery"):
    pass
try:
    client.flush(timeout=0.2)
except DatoolError:
    pass
else:
    raise AssertionError("Queue acceptance was mistaken for durable persistence")
client.request("/api/test/worker", "POST", {"paused": False})
client.flush()

for options in [{"api_key": "dtk_invalid-key"}, {"project_id": "unrelated-project"}]:
    unauthorized = Datool(**options)
    try:
        unauthorized.request("/api/traces")
    except DatoolHTTPError as error:
        assert error.status_code in {401, 403, 404}
    else:
        raise AssertionError("Unauthorized request succeeded")
    unauthorized.shutdown()

detail = client.request(f"/api/traces/{root.trace_id}")
assert detail["status"] == "completed"
assert detail["output"] == {"answer": "22 degrees"}

# Execute the exact runnable example with the real LangGraph package and installed SDK wheel.
example_path = Path(__file__).resolve().parents[1] / "examples" / "langgraph_weather.py"
spec = importlib.util.spec_from_file_location("datool_langgraph_example", example_path)
example = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = example
spec.loader.exec_module(example)
langgraph_runs = [
    example.run_sync(client),
    example.run_sync(client, stream=True),
    asyncio.run(example.run_async(client)),
    asyncio.run(example.run_async(client, stream=True)),
]


async def concurrent_graphs():
    return await asyncio.gather(
        example.run_async(client, "São Paulo"), example.run_async(client, "London")
    )


langgraph_runs.extend(asyncio.run(concurrent_graphs()))
for asynchronous in (False, True):
    try:
        if asynchronous:
            asyncio.run(example.run_async(client, "Unknown"))
        else:
            example.run_sync(client, "Unknown")
    except ValueError:
        pass
    else:
        raise AssertionError("LangGraph node error was swallowed")
client.flush()
langgraph_runs.append(
    json.loads(
        subprocess.check_output(
            [sys.executable, str(example_path), "--mode", "async", "--city", "London"],
            text=True,
        )
    )
)
# Provider fixtures still execute the actual LangChain model/tool callback machinery.
model_graph = build_model_graph()
model_runs = []
for mode in ("sync", "async", "stream", "async-stream"):
    handler = CallbackHandler(client=client)
    config = {"callbacks": [handler], "run_name": "langgraph-model"}
    inputs = {"messages": [HumanMessage(content="Weather?")]}

    async def run_model(mode, inputs, config):
        if mode == "async-stream":
            result = None
            async for snapshot in model_graph.astream(inputs, config, stream_mode="values"):
                result = snapshot
            return result
        return await model_graph.ainvoke(inputs, config)

    if mode.startswith("async"):
        result = asyncio.run(run_model(mode, inputs, config))
    elif mode == "stream":
        result = list(model_graph.stream(inputs, config, stream_mode="values"))[-1]
    else:
        result = model_graph.invoke(inputs, config)
    assert result["messages"][-1].content == "It is 22 degrees."
    model_runs.append({"trace_id": handler.last_trace_id})
    assert not handler._runs
client.flush()
# Run the actual ReAct/create_agent/Deep Agent examples from the installed SDK.
sys.path.insert(0, str(example_path.parent))
demo_agents = importlib.import_module("datool_agent_demo")
react_example = importlib.import_module("react_agent")
deep_example = importlib.import_module("deep_agent")
agent_runs = []
failed_agent_runs = []
for kind in ("react", "agent", "deep"):
    for mode in ("sync", "async", "stream", "async-stream"):
        agent_graph = (
            deep_example.build_agent()
            if kind == "deep"
            else react_example.build_agent(legacy=kind == "react")
        )
        result = asyncio.run(
            demo_agents.run_agent(agent_graph, client, name=f"{kind}-acceptance", mode=mode)
        )
        assert result["answer"] == "São Paulo: 22°C; sunny."
        agent_runs.append({**result, "kind": kind})
    failing_model = demo_agents.DemoAgentModel(fail=True)
    failing_agent = (
        deep_example.build_agent(model=failing_model)
        if kind == "deep"
        else react_example.build_agent(model=failing_model, legacy=kind == "react")
    )
    handler = CallbackHandler(client=client)
    try:
        failing_agent.invoke(
            {"messages": [{"role": "user", "content": "Weather?"}]},
            {"callbacks": [handler], "run_name": f"{kind}-failure"},
        )
    except ValueError:
        failed_agent_runs.append(handler.last_trace_id)
    else:
        raise AssertionError("Agent model failure was swallowed")
client.flush()
for kind, filename, extra_args in (
    ("react", "react_agent.py", ["--legacy"]),
    ("deep", "deep_agent.py", []),
):
    report = json.loads(
        subprocess.check_output(
            [
                sys.executable,
                str(example_path.parent / filename),
                "--mode",
                "async-stream",
                *extra_args,
            ],
            text=True,
        )
    )
    agent_runs.append({**report, "kind": kind})
Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "rootId": root.trace_id,
            "agentId": agent.id,
            "generationId": generation.id,
            "langgraphRuns": langgraph_runs,
            "langgraphModelRuns": model_runs,
            "agentRuns": agent_runs,
            "failedAgentRuns": failed_agent_runs,
        }
    )
)
client.shutdown()
print("Installed wheel: tracing, OTel, prompts, async/streams, auth, and recovery passed.")
print("LangGraph, ReAct, create_agent, and Deep Agents: real execution and callbacks passed.")
