from __future__ import annotations

import json
import math
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from opentelemetry import trace

_attributes: ContextVar[dict[str, Any] | None] = ContextVar("datool_attributes", default=None)


def safe_json(value: Any, limit: int = 20_000) -> str:
    """Bound recording without calling arbitrary repr methods or altering application values."""
    try:
        text = json.dumps(
            value, ensure_ascii=False, allow_nan=False, default=lambda v: f"<{type(v).__name__}>"
        )
    except (ValueError, TypeError, RecursionError):
        text = '"<unserializable>"'
    return text if len(text) <= limit else json.dumps(text[:limit] + "…[truncated]")


def set_attributes(span: trace.Span, values: dict[str, Any]) -> None:
    for key, value in values.items():
        if value is None:
            continue
        if isinstance(value, (str, bool, int)) or isinstance(value, float) and math.isfinite(value):
            span.set_attribute(key, value)
        else:
            span.set_attribute(key, safe_json(value))


@contextmanager
def propagate_attributes(
    *,
    session_id: str | None = None,
    user_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Iterator[None]:
    """Propagate request attributes to children in this thread/async context."""
    values = dict(_attributes.get() or {})
    if session_id is not None:
        values["session.id"] = session_id
    if user_id is not None:
        values["user.id"] = user_id
    if metadata is not None:
        values.update({f"metadata.{k}": v for k, v in metadata.items()})
    token = _attributes.set(values)
    try:
        yield
    finally:
        _attributes.reset(token)
