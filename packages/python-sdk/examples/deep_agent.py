"""Deep Agent planning and delegation with automatic Datool tracing."""

from datool_agent_demo import DemoAgentModel, main, weather
from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.language_models import BaseChatModel


def build_agent(*, model: BaseChatModel | None = None):
    planner = model if model is not None else DemoAgentModel(delegate=True)
    specialist = model if model is not None else DemoAgentModel()
    return create_deep_agent(
        model=planner,
        system_prompt="Plan the request, then delegate weather questions to weather-expert.",
        backend=StateBackend(),
        middleware=[TodoListMiddleware()],
        subagents=[
            {
                "name": "weather-expert",
                "description": "Answers weather questions using the weather tool.",
                "system_prompt": "Use the weather tool to answer the question.",
                "model": specialist,
                "tools": [weather],
            }
        ],
    )


if __name__ == "__main__":
    main(build_agent, name="deep-weather")
