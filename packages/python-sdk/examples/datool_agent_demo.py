"""Offline model and CLI helpers shared by the agent examples, not part of the SDK."""

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from typing import Any
from uuid import uuid4

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from datool import Datool
from datool.langchain import CallbackHandler


@tool
def weather(city: str) -> str:
    """Return deterministic weather for the requested city."""
    return f"{city}: 22°C; sunny."


class DemoAgentModel(BaseChatModel):
    """Deterministic tool-calling provider; replace with a real model in your app.

    This implements the model interface, while the installed agent libraries run
    the actual planning/tool/delegation loops. It never calls a model endpoint.
    """

    delegate: bool = False
    fail: bool = False

    @property
    def _llm_type(self) -> str:
        return "datool-demo-agent"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Any:
        return self.bind(tools=tools)

    def _generate(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any
    ) -> ChatResult:
        if self.fail:
            raise ValueError("demo provider failure")
        tool_results = [m for m in messages if isinstance(m, ToolMessage)]
        calls = []
        content = ""
        if not tool_results:
            if self.delegate:
                name, args = (
                    "write_todos",
                    {"todos": [{"content": "Ask the weather expert", "status": "in_progress"}]},
                )
            else:
                name, args = "weather", {"city": "São Paulo"}
            calls = [{"id": str(uuid4()), "name": name, "args": args}]
        elif self.delegate and not any(m.name == "task" for m in tool_results):
            calls = [
                {
                    "id": str(uuid4()),
                    "name": "task",
                    "args": {
                        "subagent_type": "weather-expert",
                        "description": "Get the weather in São Paulo with the weather tool.",
                    },
                }
            ]
        elif self.delegate and tool_results[-1].name == "task":
            calls = [
                {
                    "id": str(uuid4()),
                    "name": "write_todos",
                    "args": {
                        "todos": [{"content": "Ask the weather expert", "status": "completed"}]
                    },
                }
            ]
        else:
            content = "São Paulo: 22°C; sunny."
        message = AIMessage(
            content=content,
            tool_calls=calls,
            response_metadata={"model_name": self._llm_type},
        )
        # No synthetic token/cost counts: this local provider consumes no tokens.
        return ChatResult(generations=[ChatGeneration(message=message)])


async def run_agent(agent: Any, client: Datool, *, name: str, mode: str) -> dict[str, Any]:
    # This helper runs agents only. The hint also identifies legacy ReAct roots,
    # whose callbacks otherwise expose only generic LangGraph metadata.
    handler = CallbackHandler(client=client, root_type="agent")
    config: RunnableConfig = {"callbacks": [handler], "run_name": name, "recursion_limit": 50}
    inputs = {"messages": [{"role": "user", "content": "What is the weather in São Paulo?"}]}
    if mode == "sync":
        result = agent.invoke(inputs, config=config)
    elif mode == "async":
        result = await agent.ainvoke(inputs, config=config)
    elif mode == "stream":
        result = None
        for snapshot in agent.stream(inputs, config=config, stream_mode="values"):
            result = snapshot
    elif mode == "async-stream":
        result = None
        async for snapshot in agent.astream(inputs, config=config, stream_mode="values"):
            result = snapshot
    else:
        raise ValueError(f"Unknown mode: {mode}")
    await client.aflush()
    return {"trace_id": handler.last_trace_id, "answer": result["messages"][-1].content}


def main(build_agent: Any, *, name: str, legacy_option: bool = False) -> None:
    parser = argparse.ArgumentParser(description="Run an automatically traced agent in Datool.")
    parser.add_argument(
        "--mode", default="sync", choices=["sync", "async", "stream", "async-stream"]
    )
    parser.add_argument("--model", help="Provider:model ID; omit to use the offline demo model.")
    if legacy_option:
        parser.add_argument(
            "--legacy", action="store_true", help="Use LangGraph create_react_agent."
        )
    args = parser.parse_args()
    if (
        legacy_option
        and not args.legacy
        and args.mode.startswith("async")
        and sys.version_info < (3, 11)
    ):
        parser.error(
            "create_agent async tracing requires Python 3.11+; use --legacy on Python 3.10"
        )
    options = {}
    if args.model:
        from langchain.chat_models import init_chat_model

        options["model"] = init_chat_model(args.model)
    if legacy_option:
        options["legacy"] = args.legacy
    with Datool() as client:
        report = asyncio.run(run_agent(build_agent(**options), client, name=name, mode=args.mode))
    print(json.dumps(report, ensure_ascii=False))
