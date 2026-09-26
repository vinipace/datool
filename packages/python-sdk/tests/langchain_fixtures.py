"""Deterministic providers exercise real LangChain lifecycles without API calls."""

from collections.abc import Iterator
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.graph import END, START, MessagesState, StateGraph


class FixtureChatModel(BaseChatModel):
    fail: bool = False

    @property
    def _llm_type(self) -> str:
        return "fixture-weather"

    def _generate(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any
    ) -> ChatResult:
        if self.fail:
            raise ValueError("private-provider-error")
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="It is 22 degrees.",
                        response_metadata={"model_name": "fixture-weather"},
                        usage_metadata={
                            "input_tokens": 10,
                            "output_tokens": 4,
                            "total_tokens": 14,
                            "input_token_details": {"cache_read": 3},
                            "output_token_details": {"reasoning": 1},
                        },
                    )
                )
            ]
        )

    def _stream(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any
    ) -> Iterator[ChatGenerationChunk]:
        for content in ("It is ", "22 degrees."):
            yield ChatGenerationChunk(message=AIMessageChunk(content=content))
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                response_metadata={"model_name": "fixture-weather"},
                usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
            )
        )


def build_model_graph():
    @tool
    def weather(city: str) -> str:
        """Get fixture weather."""
        return f"{city}: 22 degrees"

    def lookup(state: MessagesState, config: RunnableConfig):
        result = weather.invoke({"city": "São Paulo"}, config=config)
        return {"messages": [HumanMessage(content=result)]}

    def answer(state: MessagesState, config: RunnableConfig):
        return {"messages": [FixtureChatModel().invoke(state["messages"], config=config)]}

    graph = StateGraph(MessagesState)
    graph.add_node("lookup", lookup)
    graph.add_node("answer", answer)
    graph.add_edge(START, "lookup")
    graph.add_edge("lookup", "answer")
    graph.add_edge("answer", END)
    return graph.compile()
