"""Real LangGraph execution with automatic Datool callbacks; no LLM key needed."""

import argparse
import asyncio
import json
from importlib.metadata import version
from typing import Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from datool import Datool
from datool.langchain import CallbackHandler


class WeatherState(TypedDict, total=False):
    city: str
    temperature: int
    activity: str
    answer: str


def build_graph(*, async_nodes: bool = False) -> CompiledStateGraph:
    @tool("lookup-weather")
    def weather(city: str) -> dict[str, int]:
        """Look up fixture weather for a city."""
        # Deliberately deterministic: replace this body with your weather API.
        temperatures = {"São Paulo": 22, "London": 15}
        if city not in temperatures:
            raise ValueError("No fixture weather for this city")
        return {"temperature": temperatures[city]}

    @tool("suggest-activity")
    def activity(city: str) -> dict[str, str]:
        """Suggest an activity for a city."""
        return {"activity": "visit a park" if city == "São Paulo" else "visit a museum"}

    def lookup_weather(state: WeatherState, config: RunnableConfig) -> dict[str, int]:
        return weather.invoke({"city": state["city"]}, config=config)

    def suggest_activity(state: WeatherState, config: RunnableConfig) -> dict[str, str]:
        return activity.invoke({"city": state["city"]}, config=config)

    def format_answer(state: WeatherState) -> dict[str, str]:
        # This is a formatter, not a model call: do not invent model usage or cost.
        return {"answer": f"{state['city']}: {state['temperature']}°C; {state['activity']}."}

    def compose_answer(state: WeatherState) -> dict[str, str]:
        return format_answer(state)

    async def compose_answer_async(state: WeatherState) -> dict[str, str]:
        await asyncio.sleep(0)  # Stand-in for awaited application work.
        return format_answer(state)

    builder = StateGraph(WeatherState)
    builder.add_node("lookup_weather", lookup_weather)
    builder.add_node("suggest_activity", suggest_activity)
    builder.add_node("compose_answer", compose_answer_async if async_nodes else compose_answer)
    builder.add_edge(START, "lookup_weather")
    builder.add_edge(START, "suggest_activity")
    builder.add_edge(["lookup_weather", "suggest_activity"], "compose_answer")
    builder.add_edge("compose_answer", END)
    return builder.compile()


def callback_config(handler: CallbackHandler, mode: str) -> RunnableConfig:
    return {
        "callbacks": [handler],
        "run_name": "langgraph-weather",
        "metadata": {
            "framework": "langgraph",
            "langgraph_version": version("langgraph"),
            "mode": mode,
        },
    }


def run_sync(datool: Datool, city: str = "São Paulo", *, stream: bool = False) -> dict[str, Any]:
    graph = build_graph()
    handler = CallbackHandler(client=datool)
    config = callback_config(handler, "stream" if stream else "sync")
    if stream:
        result = {}
        for snapshot in graph.stream({"city": city}, config=config, stream_mode="values"):
            result = snapshot
    else:
        result = graph.invoke({"city": city}, config=config)
    datool.flush()
    return {"trace_id": handler.last_trace_id, "result": result}


async def run_async(
    datool: Datool, city: str = "São Paulo", *, stream: bool = False
) -> dict[str, Any]:
    graph = build_graph(async_nodes=True)
    handler = CallbackHandler(client=datool)
    config = callback_config(handler, "async-stream" if stream else "async")
    if stream:
        result = {}
        async for snapshot in graph.astream({"city": city}, config=config, stream_mode="values"):
            result = snapshot
    else:
        result = await graph.ainvoke({"city": city}, config=config)
    await datool.aflush()
    return {"trace_id": handler.last_trace_id, "result": result}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", default="São Paulo", choices=["São Paulo", "London"])
    parser.add_argument(
        "--mode", default="sync", choices=["sync", "async", "stream", "async-stream"]
    )
    args = parser.parse_args()
    with Datool() as datool:
        if args.mode.startswith("async"):
            report = asyncio.run(run_async(datool, args.city, stream=args.mode == "async-stream"))
        else:
            report = run_sync(datool, args.city, stream=args.mode == "stream")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
