"""Automatic LangChain and LangGraph tracing through their public callback API."""

from __future__ import annotations

import threading
from collections.abc import Mapping, Sequence
from dataclasses import fields, is_dataclass
from typing import Any, Literal
from uuid import UUID

try:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.documents import Document
    from langchain_core.messages import BaseMessage, BaseMessageChunk, message_chunk_to_message
    from langchain_core.outputs import LLMResult
except ImportError as exc:
    raise ImportError(
        "Install the Datool LangChain extra: pip install 'datool[langchain]'"
    ) from exc

from ._transport import DatoolError
from .client import Datool, Observation, ObservationType, _record_exception, get_client


def _value(value: Any, depth: int = 0) -> Any:
    """Capture public message/document contents, never serialized model credentials."""
    if depth > 16:
        return "<nested value>"
    if isinstance(value, BaseMessageChunk):
        value = message_chunk_to_message(value)
    if isinstance(value, BaseMessage):
        role = {"human": "user", "ai": "assistant"}.get(value.type, value.type)
        result = {"role": getattr(value, "role", role), "content": _value(value.content, depth + 1)}
        for key in ("name", "tool_calls", "invalid_tool_calls", "tool_call_id"):
            item = getattr(value, key, None)
            if item:
                result[key] = _value(item, depth + 1)
        return result
    if isinstance(value, Document):
        return {"page_content": value.page_content, "metadata": _value(value.metadata, depth + 1)}
    # Command/Send state updates are public LangGraph data classes. Inspect their
    # fields without requiring LangGraph in a plain LangChain installation, and
    # recurse here instead of asdict() so nested messages retain their roles.
    if (
        is_dataclass(value)
        and not isinstance(value, type)
        and type(value).__module__ == "langgraph.types"
    ):
        return {f.name: _value(getattr(value, f.name), depth + 1) for f in fields(value)}
    if isinstance(value, Mapping):
        return {str(k): _value(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_value(v, depth + 1) for v in value]
    return value


def _usage(values: Mapping[str, Any]) -> dict[str, int]:
    result = {}
    for target, sources in {
        "input": ("input_tokens", "prompt_tokens"),
        "output": ("output_tokens", "completion_tokens"),
        "total": ("total_tokens",),
    }.items():
        for source in sources:
            count = values.get(source)
            if type(count) is int and count >= 0:
                result[target] = count
                break
    for container, mappings in {
        "input_token_details": {"cache_read": "cache_read", "cache_creation": "cache_write"},
        "output_token_details": {"reasoning": "reasoning"},
        "prompt_tokens_details": {"cached_tokens": "cache_read"},
        "completion_tokens_details": {"reasoning_tokens": "reasoning"},
    }.items():
        details = values.get(container)
        if isinstance(details, Mapping):
            for source, target in mappings.items():
                count = details.get(source)
                if type(count) is int and count >= 0:
                    result[target] = count
    return result


class CallbackHandler(BaseCallbackHandler):
    """Pass one reusable handler in ``config={"callbacks": [handler]}``.

    Run IDs establish parentage without changing the application's OTel context.
    Roots inherit the current Datool observation, if any. ``last_trace_id`` is a
    convenience for sequential calls; supply a run_id and use ``get_trace_id``
    while that run is active when sharing a handler across concurrent requests.
    Flush the client after consuming streams. Callback failures are surfaced by
    client.flush(), without replacing application exceptions.

    Agent integrations and graph steps are classified from callback metadata.
    Use ``root_type="agent"`` for legacy/custom agents that identify themselves
    only as generic LangGraph graphs. This applies only to callback roots.
    """

    run_inline = True

    def __init__(
        self,
        *,
        client: Datool | None = None,
        root_type: Literal["agent", "workflow", "chain"] | None = None,
    ) -> None:
        if root_type not in {None, "agent", "workflow", "chain"}:
            raise ValueError("root_type must be agent, workflow, or chain")
        self.client = client if client is not None else get_client()
        self.root_type = root_type
        self.last_trace_id: str | None = None
        self._runs: dict[UUID, Observation] = {}
        self._run_metadata: dict[UUID, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def _chain_type(
        self,
        info: dict[str, Any],
        metadata: dict[str, Any],
        tags: list[str],
        parent_run_id: UUID | None,
    ) -> ObservationType:
        if parent_run_id is None and self.root_type is not None:
            return self.root_type
        identifiers = info.get("id")
        if isinstance(identifiers, list) and any(
            isinstance(part, str) and "agent" in part.lower() for part in identifiers
        ):
            return "agent"
        # Graph-step tags are local to the node callback. Metadata alone is
        # inherited by Prompt/RunnableSequence/model helpers, which are not tasks.
        node = metadata.get("langgraph_node")
        if node and any(tag.startswith("graph:step:") for tag in tags):
            return "agent" if node == "agent" else "task"
        integration = metadata.get("ls_integration")
        parent = self._run_metadata.get(parent_run_id, {}) if parent_run_id else {}
        # Detect entry into an integration, including a named delegated agent.
        # Do not turn every child into an agent just because metadata is inherited.
        entering = (
            parent_run_id is None
            or integration != parent.get("ls_integration")
            or metadata.get("lc_agent_name") != parent.get("lc_agent_name")
        )
        if entering:
            if integration in {"langchain_create_agent", "deepagents"}:
                return "agent"
            if integration == "langgraph":
                return "workflow"
        return "chain"

    def get_trace_id(self, run_id: UUID) -> str | None:
        """Return the trace for an active callback run, without retaining completed runs."""
        with self._lock:
            run = self._runs.get(run_id)
            return run.trace_id if run else None

    def _start(
        self,
        serialized: dict[str, Any] | None,
        inputs: Any,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        as_type: ObservationType,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        name: str | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            with self._lock:
                if run_id in self._runs:
                    return
                parent = self._runs.get(parent_run_id) if parent_run_id else None
                info = serialized or {}
                identifiers = info.get("id")
                fallback = (
                    identifiers[-1] if isinstance(identifiers, list) and identifiers else None
                )
                label = name or info.get("name") or fallback or as_type
                params = kwargs.get("invocation_params") or {}
                meta = dict(metadata or {})
                if as_type == "chain":
                    as_type = self._chain_type(info, meta, tags or [], parent_run_id)
                model = meta.get("ls_model_name") or params.get("model_name") or params.get("model")
                options = {
                    "name": str(label).strip()[:200] or as_type,
                    "as_type": as_type,
                    "input": _value(inputs),
                    "metadata": {
                        **meta,
                        "langchain.run_id": str(run_id),
                        "langchain.tags": tags or [],
                    },
                    "model": model if as_type == "generation" and isinstance(model, str) else None,
                }
                observation = (
                    parent.start_observation(**options)
                    if parent
                    else self.client.start_observation(**options)
                )
                self._runs[run_id] = observation
                self._run_metadata[run_id] = meta
                if parent is None:
                    self.last_trace_id = observation.trace_id
        except Exception:
            self.client.processor.failure = DatoolError("Datool LangChain callback start failed")

    def _finish(
        self,
        run_id: UUID,
        *,
        output: Any = None,
        error: BaseException | None = None,
        response: LLMResult | None = None,
    ) -> None:
        with self._lock:
            observation = self._runs.pop(run_id, None)
            self._run_metadata.pop(run_id, None)
        if observation is None:
            return
        try:
            if error is not None:
                _record_exception(observation, error)
            elif response is not None:
                self._record_llm(observation, response)
            else:
                observation.update(output=_value(output))
        except Exception:
            self.client.processor.failure = DatoolError(
                "Datool LangChain callback completion failed"
            )
        finally:
            observation.end()

    def _record_llm(self, observation: Observation, response: LLMResult) -> None:
        provider = response.llm_output or {}
        model = provider.get("model_name") or provider.get("model")
        usage = _usage(provider.get("token_usage") or provider.get("usage") or {})
        message_usage: dict[str, int] = {}
        outputs = []
        for generations in response.generations:
            outputs.append(
                [_value(g.message) if hasattr(g, "message") else g.text for g in generations]
            )
            if generations and isinstance(
                message := getattr(generations[0], "message", None), BaseMessage
            ):
                model = (
                    model
                    or message.response_metadata.get("model_name")
                    or message.response_metadata.get("model")
                )
                for key, count in _usage(getattr(message, "usage_metadata", None) or {}).items():
                    message_usage[key] = message_usage.get(key, 0) + count
        observation.update(
            output=outputs,
            model=model if isinstance(model, str) else None,
            usage_details=usage or message_usage or None,
        )

    def on_chain_start(
        self, serialized: dict[str, Any] | None, inputs: Any, *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._start(serialized, inputs, run_id=run_id, as_type="chain", **kwargs)

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, output=outputs)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, error=error)

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[BaseMessage]],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        self._start(serialized, messages, run_id=run_id, as_type="generation", **kwargs)

    def on_llm_start(
        self, serialized: dict[str, Any], prompts: list[str], *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._start(serialized, prompts, run_id=run_id, as_type="generation", **kwargs)

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, response=response)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, error=error)

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        self._start(
            serialized,
            inputs if inputs is not None else input_str,
            run_id=run_id,
            as_type="tool",
            **kwargs,
        )

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, output=output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, error=error)

    def on_retriever_start(
        self, serialized: dict[str, Any], query: str, *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._start(serialized, query, run_id=run_id, as_type="retriever", **kwargs)

    def on_retriever_end(
        self, documents: Sequence[Document], *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._finish(run_id, output=list(documents))

    def on_retriever_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish(run_id, error=error)
