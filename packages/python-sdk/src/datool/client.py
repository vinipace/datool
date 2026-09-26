from __future__ import annotations

import asyncio
import math
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Literal

import httpx
from opentelemetry import context, trace
from opentelemetry.sdk.trace import TracerProvider

from ._recording import _attributes, safe_json, set_attributes
from .otel import DatoolSpanProcessor
from .prompts import DatoolPrompts

ObservationType = Literal[
    "span",
    "generation",
    "embedding",
    "agent",
    "task",
    "tool",
    "chain",
    "retriever",
    "evaluator",
    "guardrail",
    "workflow",
]
_kinds = {
    "span": "custom",
    "generation": "llm",
    "embedding": "llm",
    "agent": "agent",
    "task": "task",
    "tool": "tool",
    "chain": "function",
    "retriever": "function",
    "evaluator": "score",
    "guardrail": "function",
    "workflow": "workflow",
}
_unset = object()


class Observation:
    def __init__(self, span: trace.Span, client: Datool) -> None:
        self.span, self.client = span, client

    @property
    def id(self) -> str:
        return f"{self.span.get_span_context().span_id:016x}"

    @property
    def trace_id(self) -> str:
        return f"{self.span.get_span_context().trace_id:032x}"

    def update(
        self,
        *,
        input: Any = _unset,
        output: Any = _unset,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        usage_details: dict[str, int] | None = None,
        cost_details: dict[str, float] | None = None,
        level: Literal["DEFAULT", "ERROR"] | None = None,
        status_message: str | None = None,
    ) -> Observation:
        for key, value in (("input", input), ("output", output)):
            if value is not _unset:
                self.span.set_attribute(
                    key, safe_json(self.client.mask(value), self.client.max_io_characters)
                )
        if metadata is not None:
            set_attributes(self.span, {f"metadata.{k}": v for k, v in metadata.items()})
        if model is not None:
            self.span.set_attribute("model", model)
        if usage_details is not None:
            keys = {
                "input": "input_tokens",
                "output": "output_tokens",
                "total": "total_tokens",
                "cache_read": "cache_read_tokens",
                "cache_write": "cache_write_tokens",
                "reasoning": "reasoning_tokens",
            }
            for key, value in usage_details.items():
                if key not in keys or type(value) is not int or value < 0:
                    raise ValueError("Invalid usage_details: use nonnegative integer token counts")
                self.span.set_attribute(f"usage.{keys[key]}", value)
            if "input" in usage_details and "output" in usage_details:
                self.span.set_attribute(
                    "usage.total_tokens", usage_details["input"] + usage_details["output"]
                )
        if cost_details is not None:
            if any(
                k not in {"input", "output", "total"}
                or isinstance(v, bool)
                or not isinstance(v, (int, float))
                or not math.isfinite(v)
                or v < 0
                for k, v in cost_details.items()
            ):
                raise ValueError("Invalid cost_details: use nonnegative finite USD amounts")
            if "total" in cost_details:
                self.span.set_attribute("cost.usd", cost_details["total"])
                self.span.set_attribute("cost.status", "complete")
            elif "input" in cost_details and "output" in cost_details:
                self.span.set_attribute("cost.usd", cost_details["input"] + cost_details["output"])
                self.span.set_attribute("cost.status", "complete")
        if level == "ERROR":
            self.span.set_status(trace.Status(trace.StatusCode.ERROR, status_message))
        return self

    def end(self) -> None:
        self.span.end()

    def start_observation(self, **kwargs: Any) -> Observation:
        return self.client.start_observation(
            _context=trace.set_span_in_context(self.span), **kwargs
        )

    def start_as_current_observation(self, **kwargs: Any) -> Any:
        return self.client.start_as_current_observation(
            _context=trace.set_span_in_context(self.span), **kwargs
        )


class Datool:
    """Python instrumentation backed by Datool's native API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        project_id: str | None = None,
        base_url: str | None = None,
        timeout: float = 10,
        retries: int = 3,
        max_queue_size: int = 10_000,
        max_io_characters: int = 20_000,
        mask: Callable[[Any], Any] | None = None,
        http_client: httpx.Client | None = None,
        tracer_provider: TracerProvider | None = None,
        prompt_cache_ttl: float = 30,
        prompt_cache_size: int = 256,
    ) -> None:
        if max_io_characters < 1:
            raise ValueError("max_io_characters must be positive")
        self.max_io_characters = max_io_characters
        self.mask = mask or (lambda value: value)
        self.processor = DatoolSpanProcessor(
            api_key=api_key,
            project_id=project_id,
            base_url=base_url,
            timeout=timeout,
            retries=retries,
            max_queue_size=max_queue_size,
            http_client=http_client,
        )
        # Never replace the application's global provider or shut down a caller-owned provider.
        self.provider = tracer_provider or TracerProvider(shutdown_on_exit=False)
        self.provider.add_span_processor(self.processor)
        self.tracer = self.provider.get_tracer("datool", "0.1.0")
        self.prompts = DatoolPrompts(
            self.processor.transport, cache_ttl=prompt_cache_ttl, cache_size=prompt_cache_size
        )
        self.closed = False

    def start_observation(
        self,
        *,
        name: str,
        as_type: ObservationType = "span",
        input: Any = _unset,
        output: Any = _unset,
        metadata: dict[str, Any] | None = None,
        model: str | None = None,
        usage_details: dict[str, int] | None = None,
        cost_details: dict[str, float] | None = None,
        group: dict[str, Any] | None = None,
        _context: context.Context | None = None,
    ) -> Observation:
        if self.closed:
            raise RuntimeError("Datool is shut down")
        if not name.strip() or len(name) > 200 or as_type not in _kinds:
            raise ValueError("Invalid observation name or type")
        attributes: dict[str, Any] = {
            **(_attributes.get() or {}),
            "datool.span.kind": _kinds[as_type],
            "datool.trace.root": True,
        }
        if group is not None:
            if (
                set(group) - {"type", "name", "version"}
                or group.get("type") not in {"agent", "workflow"}
                or not isinstance(group.get("name"), str)
                or not group["name"].strip()
                or len(group["name"]) > 200
            ):
                raise ValueError("Invalid invocation group")
            if group.get("version") is not None and (
                not isinstance(group["version"], str)
                or not group["version"].strip()
                or len(group["version"]) > 200
            ):
                raise ValueError("Invalid group version")
            attributes.update({f"datool.group.{k}": v for k, v in group.items() if v is not None})
        # Start attributes are immutable for grouping/session identity on the server.
        attrs = {
            k: v if isinstance(v, (str, int, float, bool)) else safe_json(v)
            for k, v in attributes.items()
        }
        span = self.tracer.start_span(name, context=_context, attributes=attrs)
        observation = Observation(span, self)
        try:
            return observation.update(
                input=input,
                output=output,
                metadata=metadata,
                model=model,
                usage_details=usage_details,
                cost_details=cost_details,
            )
        except BaseException:
            span.end()
            raise

    @contextmanager
    def start_as_current_observation(self, **kwargs: Any) -> Iterator[Observation]:
        observation = self.start_observation(**kwargs)
        with trace.use_span(
            observation.span,
            end_on_exit=False,
            record_exception=False,
            set_status_on_exception=False,
        ):
            try:
                yield observation
            except BaseException as exc:
                _record_exception(observation, exc)
                raise
            finally:
                observation.end()

    def update_current_observation(self, **kwargs: Any) -> None:
        Observation(trace.get_current_span(), self).update(**kwargs)

    def get_current_trace_id(self) -> str | None:
        span = trace.get_current_span().get_span_context()
        return f"{span.trace_id:032x}" if span.is_valid else None

    def observe(self, **kwargs: Any) -> Any:
        from .decorators import observe

        return observe(client=self, **kwargs)

    def request(self, path: str, method: str = "GET", body: Any = None) -> Any:
        return self.processor.transport.request(path, method, body)

    async def arequest(self, path: str, method: str = "GET", body: Any = None) -> Any:
        return await asyncio.to_thread(self.request, path, method, body)

    def flush(self, timeout: float = 60) -> None:
        self.processor.force_flush(int(timeout * 1000))

    async def aflush(self, timeout: float = 60) -> None:
        await asyncio.to_thread(self.flush, timeout)

    def shutdown(self) -> None:
        if not self.closed:
            self.processor.shutdown()
            self.closed = True

    async def ashutdown(self) -> None:
        await asyncio.to_thread(self.shutdown)

    def __enter__(self) -> Datool:
        return self

    def __exit__(self, *args: Any) -> None:
        self.shutdown()

    async def __aenter__(self) -> Datool:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.ashutdown()


def _record_exception(observation: Observation, exc: BaseException) -> None:
    if isinstance(exc, (GeneratorExit, asyncio.CancelledError)):
        observation.span.set_attribute("datool.span.cancelled", True)
    else:
        # Avoid exception strings/stacktraces that can carry secrets; preserve type and status.
        observation.span.set_attribute("error.type", type(exc).__name__)
        observation.span.set_status(trace.Status(trace.StatusCode.ERROR, type(exc).__name__))


_default: Datool | None = None
_default_lock = threading.Lock()


def get_client() -> Datool:
    """Return a lazily created process client configured through DATOOL_* variables."""
    global _default
    with _default_lock:
        if _default is None or _default.closed:
            _default = Datool()
        return _default
