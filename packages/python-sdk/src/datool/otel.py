"""Export native and third-party OpenTelemetry spans to Datool lifecycle events."""

from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.trace import StatusCode

from ._recording import _attributes, safe_json
from ._transport import DatoolError, Transport


def _timestamp(nanos: int | None) -> str:
    return datetime.fromtimestamp((nanos or 0) / 1e9, timezone.utc).isoformat()


def _kind(a: dict[str, Any]) -> str:
    explicit = a.get("datool.span.kind")
    if explicit in {"agent", "custom", "function", "llm", "score", "task", "tool", "workflow"}:
        return str(explicit)
    operation = a.get("gen_ai.operation.name")
    if operation in {"chat", "text_completion", "embeddings", "generate_content"}:
        return "llm"
    return "tool" if operation == "execute_tool" else "custom"


def _fields(span: ReadableSpan, extra: dict[str, Any]) -> dict[str, Any]:
    a = {**dict(span.resource.attributes), **extra, **dict(span.attributes or {})}
    a["otel.name"] = span.name
    if span.status.description:
        a["error.message"] = span.status.description
    if span.events:
        a["otel.events"] = [
            {"name": e.name, "attributes": dict(e.attributes or {})} for e in span.events
        ]
    result: dict[str, Any] = {"attributes": json.loads(safe_json(a, 200_000))}
    for field_name, keys in {
        "input": ("input", "gen_ai.input.messages", "gen_ai.tool.call.arguments"),
        "output": ("output", "gen_ai.output.messages", "gen_ai.tool.call.result"),
    }.items():
        for key in keys:
            if key in a:
                value = a[key]
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        pass
                result[field_name] = value
                break
    # Attributes must always be an object, even when recording was truncated.
    if not isinstance(result["attributes"], dict):
        result["attributes"] = {"datool.attributes.truncated": True}
    return result


def _aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    if not records:
        return {}
    result: dict[str, Any] = {"usage.llm_calls": len(records)}
    known = 0
    for a in records:
        counts = []
        for key in ("input", "output"):
            value = a.get(f"usage.{key}_tokens", a.get(f"gen_ai.usage.{key}_tokens"))
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                field_name = f"usage.{key}_tokens"
                result[field_name] = result.get(field_name, 0) + value
                counts.append(value)
        if len(counts) == 2:
            known += 1
    result["usage.status"] = (
        "complete" if known == len(records) else "partial" if known else "missing"
    )
    if "usage.input_tokens" in result and "usage.output_tokens" in result:
        result["usage.total_tokens"] = result["usage.input_tokens"] + result["usage.output_tokens"]
    costs = [
        a["cost.usd"]
        for a in records
        if type(a.get("cost.usd")) in {int, float}
        and math.isfinite(a["cost.usd"])
        and a["cost.usd"] >= 0
        and a.get("cost.status") not in {"missing", "partial"}
    ]
    result["cost.status"] = (
        "complete" if len(costs) == len(records) else "partial" if costs else "missing"
    )
    if costs:
        result["cost.known_usd"] = sum(costs)
        if len(costs) == len(records):
            result["cost.usd"] = sum(costs)
    models = sorted(
        {
            str(a.get("gen_ai.response.model", a.get("model", a.get("gen_ai.request.model"))))
            for a in records
            if any(k in a for k in ("gen_ai.response.model", "model", "gen_ai.request.model"))
        }
    )
    result["models"] = models
    if len(models) == 1:
        result["model"] = models[0]
    return result


@dataclass
class _Record:
    parent_id: str | None
    kind: str
    hidden: bool
    extra: dict[str, Any]
    final: dict[str, Any] | None = None


@dataclass
class _Trace:
    root_id: str
    active: int = 0
    failed: bool = False
    cancelled: bool = False
    ended_at: str = ""
    records: dict[str, _Record] = field(default_factory=dict)


class DatoolSpanProcessor(SpanProcessor):
    """Add to an existing TracerProvider, or use Datool's private provider.

    Export happens on a worker thread. force_flush raises on delivery failure and
    waits for PostgreSQL receipts, including the ordered predecessor chain.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        project_id: str | None = None,
        base_url: str | None = None,
        timeout: float = 10,
        retries: int = 3,
        max_queue_size: int = 10_000,
        http_client: httpx.Client | None = None,
    ) -> None:
        key = (api_key if api_key is not None else os.getenv("DATOOL_API_KEY", "")).strip()
        project = (
            project_id if project_id is not None else os.getenv("DATOOL_PROJECT_ID", "")
        ).strip()
        if not key or not project:
            raise ValueError(
                "Set DATOOL_API_KEY and DATOOL_PROJECT_ID or pass api_key and project_id"
            )
        self.transport = Transport(
            base_url=base_url or os.environ.get("DATOOL_BASE_URL") or "http://127.0.0.1:3000",
            api_key=key,
            project_id=project,
            timeout=timeout,
            retries=retries,
            max_queue_size=max_queue_size,
            http_client=http_client,
        )
        self.lock = threading.RLock()
        self.traces: dict[str, _Trace] = {}
        self.failure: DatoolError | None = None

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        try:
            with self.lock:
                self._start(span)
        except Exception:
            self.failure = DatoolError("Datool could not record span start")

    def _start(self, span: ReadableSpan) -> None:
        assert span.context is not None
        trace_id, span_id = f"{span.context.trace_id:032x}", f"{span.context.span_id:016x}"
        a = dict(span.attributes or {})
        extra = json.loads(safe_json(_attributes.get() or {}, 200_000))
        if not isinstance(extra, dict):
            extra = {"datool.attributes.truncated": True}
        initial = _fields(span, extra)
        group = {"type": a.get("datool.group.type"), "name": a.get("datool.group.name")}
        if a.get("datool.group.version"):
            group["version"] = a["datool.group.version"]
        group_fields = {"group": group} if group["type"] and group["name"] else {}
        state = self.traces.get(trace_id)
        hidden = state is None and a.get("datool.trace.root") is True and _kind(a) != "llm"
        if state is None:
            state = self.traces[trace_id] = _Trace(span_id)
            session_id = initial["attributes"].get("session.id")
            self.transport.enqueue(
                "/api/traces",
                "POST",
                {
                    "id": trace_id,
                    "name": span.name[:200],
                    "operation": _kind(a),
                    "startedAt": _timestamp(span.start_time),
                    "status": "running",
                    **initial,
                    **(group_fields if hidden else {}),
                    **({"sessionId": session_id} if session_id else {}),
                },
            )
        parent_id = f"{span.parent.span_id:016x}" if span.parent else None
        if parent_id not in state.records:
            parent_id = None
        record = _Record(parent_id, _kind(a), hidden, extra)
        state.records[span_id] = record
        state.active += 1
        if not hidden:
            self.transport.enqueue(
                f"/api/traces/{trace_id}/spans",
                "POST",
                {
                    "id": span_id,
                    "parentId": None
                    if parent_id and state.records[parent_id].hidden
                    else parent_id,
                    "name": span.name[:200],
                    "kind": record.kind,
                    "startedAt": _timestamp(span.start_time),
                    "status": "running",
                    **initial,
                    **group_fields,
                },
            )

    def on_end(self, span: ReadableSpan) -> None:
        try:
            with self.lock:
                self._end(span)
        except Exception:
            self.failure = DatoolError("Datool could not record span completion")

    def _end(self, span: ReadableSpan) -> None:
        assert span.context is not None
        trace_id, span_id = f"{span.context.trace_id:032x}", f"{span.context.span_id:016x}"
        state = self.traces.get(trace_id)
        if not state or span_id not in state.records:
            return
        record = state.records[span_id]
        if record.final is not None:
            return
        cancelled = (span.attributes or {}).get("datool.span.cancelled") is True
        status = (
            "errored"
            if span.status.status_code == StatusCode.ERROR
            else "cancelled"
            if cancelled
            else "completed"
        )
        final = record.final = _fields(span, record.extra)
        ended_at = _timestamp(span.end_time)
        if not record.hidden:
            self.transport.enqueue(
                f"/api/spans/{span_id}", "PATCH", {**final, "status": status, "endedAt": ended_at}
            )
        state.failed |= status == "errored"
        state.cancelled |= cancelled
        state.ended_at = max(state.ended_at, ended_at)
        state.active -= 1
        if state.active:
            return
        llms = [(sid, r) for sid, r in state.records.items() if r.kind == "llm" and r.final]
        for sid, wrapper in state.records.items():
            if wrapper.kind == "llm" or wrapper.hidden or not wrapper.final:
                continue
            descendants = []
            for _, llm in llms:
                parent = llm.parent_id
                while parent:
                    if parent == sid:
                        descendants.append((llm.final or {})["attributes"])
                        break
                    parent = state.records[parent].parent_id
            if descendants:
                self.transport.enqueue(
                    f"/api/spans/{sid}",
                    "PATCH",
                    {
                        "attributes": {
                            **wrapper.final["attributes"],
                            **_aggregate(descendants),
                        },
                    },
                )
        root = state.records[state.root_id].final or {"attributes": {}}
        self.transport.enqueue(
            f"/api/traces/{trace_id}",
            "PATCH",
            {
                **root,
                "attributes": {
                    **root["attributes"],
                    **_aggregate([(r.final or {})["attributes"] for _, r in llms]),
                },
                "endedAt": state.ended_at,
                "status": "errored"
                if state.failed
                else "cancelled"
                if state.cancelled
                else "completed",
            },
        )
        del self.traces[trace_id]

    def force_flush(self, timeout_millis: int = 60_000) -> bool:
        if self.failure:
            raise self.failure
        self.transport.flush(timeout_millis / 1000)
        return True

    def shutdown(self) -> None:
        if self.failure:
            raise self.failure
        self.transport.shutdown()
