"""ReAct tool-call loop with automatic Datool tracing."""

from datool_agent_demo import DemoAgentModel, main, weather
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel


def build_agent(*, model: BaseChatModel | None = None, legacy: bool = False):
    model = model if model is not None else DemoAgentModel()
    instructions = "Use the weather tool to answer the user's question."
    if legacy:
        from langgraph.prebuilt import create_react_agent

        return create_react_agent(model, [weather], prompt=instructions)
    return create_agent(model, tools=[weather], system_prompt=instructions)


if __name__ == "__main__":
    main(build_agent, name="react-weather", legacy_option=True)
