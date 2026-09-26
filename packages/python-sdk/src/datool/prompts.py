from __future__ import annotations

import asyncio
import copy
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace

from ._transport import DatoolError, Transport

_placeholder = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}")


@dataclass(frozen=True)
class RuntimePrompt:
    id: str
    slug: str
    version: int
    model: str
    provider: str
    messages: list[dict[str, str]]
    metadata: dict[str, Any]
    settings: dict[str, Any]
    template: str

    def render(self, variables: dict[str, str] | None = None) -> list[dict[str, str]]:
        values = variables or {}
        if any(not isinstance(v, str) for v in values.values()):
            raise ValueError("Prompt variables must be strings")
        if self.template == "none":
            return copy.deepcopy(self.messages)
        required = {
            m.group(1)
            for message in self.messages
            for m in _placeholder.finditer(message["content"])
        }
        missing = sorted(required - values.keys())
        if missing:
            raise ValueError(f"Missing prompt variables: {', '.join(missing)}")
        return [
            {**m, "content": _placeholder.sub(lambda match: values[match.group(1)], m["content"])}
            for m in self.messages
        ]


class DatoolPrompts:
    """Published prompts with a client-private bounded cache. No stale-on-error fallback."""

    def __init__(
        self, transport: Transport, *, cache_ttl: float = 30, cache_size: int = 256
    ) -> None:
        if not 0 <= cache_ttl <= 300 or not 1 <= cache_size <= 10_000:
            raise ValueError("Invalid prompt cache TTL or capacity")
        self.transport, self.ttl, self.capacity = transport, cache_ttl, cache_size
        self.cache: OrderedDict[tuple[str, int | None], tuple[float, dict[str, Any]]] = (
            OrderedDict()
        )
        self.lock = threading.RLock()

    def get(self, slug: str, *, version: int | None = None) -> RuntimePrompt:
        if len(slug) > 120 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            raise ValueError("Invalid prompt slug")
        if version is not None and (type(version) is not int or version < 1):
            raise ValueError("Prompt version must be a positive integer")
        key = (slug, version)
        with self.lock:
            cached = self.cache.get(key)
            if cached and cached[0] > time.monotonic():
                definition = copy.deepcopy(cached[1])
                self.cache.move_to_end(key)
            else:
                suffix = f"?version={version}" if version is not None else ""
                definition = self.transport.request(f"/api/prompts/by-slug/{slug}{suffix}")
                if (
                    not isinstance(definition, dict)
                    or definition.get("slug") != slug
                    or type(definition.get("version")) is not int
                    or definition["version"] < 1
                    or version is not None
                    and definition["version"] != version
                    or any(
                        not isinstance(definition.get(k), str) or not definition[k]
                        for k in ("id", "model", "provider")
                    )
                    or definition.get("template", "mustache") not in {"mustache", "none"}
                    or not isinstance(definition.get("metadata", {}), dict)
                    or not isinstance(definition.get("messages"), list)
                    or not definition["messages"]
                    or any(
                        not isinstance(m, dict)
                        or m.get("role") not in {"system", "user", "assistant"}
                        or not isinstance(m.get("content"), str)
                        for m in definition["messages"]
                    )
                ):
                    raise DatoolError("Datool returned an invalid published prompt")
                self.cache[key] = (
                    float("inf") if version else time.monotonic() + self.ttl,
                    copy.deepcopy(definition),
                )
                self.cache.move_to_end(key)
                while len(self.cache) > self.capacity:
                    self.cache.popitem(last=False)
        try:
            prompt = RuntimePrompt(
                id=definition["id"],
                slug=slug,
                version=definition["version"],
                model=definition["model"],
                provider=definition["provider"],
                messages=definition["messages"],
                metadata=definition.get("metadata", {}),
                settings={
                    k: definition[k]
                    for k in ("temperature", "maxTokens", "output")
                    if k in definition
                },
                template=definition.get("template", "mustache"),
            )
        except (KeyError, TypeError):
            raise DatoolError("Datool returned an invalid published prompt") from None
        trace.get_current_span().add_event(
            "datool.prompt.resolve",
            {
                "datool.prompt.id": prompt.id,
                "datool.prompt.slug": slug,
                "datool.prompt.version": prompt.version,
                "datool.prompt.model": prompt.model,
            },
        )
        return prompt

    async def aget(self, slug: str, *, version: int | None = None) -> RuntimePrompt:
        return await asyncio.to_thread(self.get, slug, version=version)
