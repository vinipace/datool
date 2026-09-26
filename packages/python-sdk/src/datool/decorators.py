from __future__ import annotations

import inspect
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import wraps
from typing import Any, TypeVar, overload

from opentelemetry import context, trace

from ._recording import _attributes
from ._transport import DatoolError
from .client import Datool, Observation, ObservationType, _record_exception, get_client

F = TypeVar("F", bound=Callable[..., Any])


def _update(observation: Observation, **kwargs: Any) -> None:
    try:
        observation.update(**kwargs)
    except Exception:
        observation.client.processor.failure = DatoolError(
            "Datool could not capture observation data"
        )


class _Stream:
    """Activate context only while the producer runs, never across a yielded chunk."""

    def __init__(
        self, iterator: Any, client: Datool, options: dict[str, Any], capture_output: bool
    ) -> None:
        self.iterator, self.client, self.options = iterator, client, options
        self.capture_output = capture_output
        self.parent = context.get_current()
        self.attributes = _attributes.get()
        self.observation: Observation | None = None
        self.output: Any = None
        self.closed = False

    def _start(self) -> Observation:
        if self.observation is None:
            self.observation = self.client.start_observation(_context=self.parent, **self.options)
        return self.observation

    @contextmanager
    def _activate(self) -> Iterator[None]:
        attributes_token = _attributes.set(self.attributes)
        try:
            observation = self._start()
            token = context.attach(trace.set_span_in_context(observation.span, self.parent))
            try:
                yield
            finally:
                context.detach(token)
        finally:
            self.attributes = _attributes.get()
            _attributes.reset(attributes_token)

    def _capture(self, value: Any) -> Any:
        if self.capture_output:
            if isinstance(value, str):
                self.output = ((self.output if isinstance(self.output, str) else "") + value)[
                    : self.client.max_io_characters
                ]
            else:
                self.output = value
        return value

    def _end(self, exc: BaseException | None = None) -> None:
        self.closed = True
        if self.observation is not None:
            if exc is not None:
                _record_exception(self.observation, exc)
            if self.capture_output:
                _update(self.observation, output=self.output)
            self.observation.end()

    def __iter__(self) -> _Stream:
        return self

    def __next__(self) -> Any:
        return self.send(None)

    def _step(self, method: str, *args: Any) -> Any:
        if self.closed:
            raise StopIteration
        with self._activate():
            try:
                return self._capture(getattr(self.iterator, method)(*args))
            except StopIteration:
                self._end()
                raise
            except BaseException as exc:
                self._end(exc)
                raise

    def send(self, value: Any) -> Any:
        return self._step("send", value)

    def throw(self, *args: Any) -> Any:
        return self._step("throw", *args)

    def close(self) -> None:
        if self.closed:
            return
        if self.observation is None:
            self.iterator.close()
            self.closed = True
            return
        with self._activate():
            try:
                self.iterator.close()
            except BaseException as exc:
                self._end(exc)
                raise
            else:
                self._end(GeneratorExit())


class _AsyncStream(_Stream):
    def __aiter__(self) -> _AsyncStream:
        return self

    async def __anext__(self) -> Any:
        return await self.asend(None)

    async def _astep(self, method: str, *args: Any) -> Any:
        if self.closed:
            raise StopAsyncIteration
        with self._activate():
            try:
                return self._capture(await getattr(self.iterator, method)(*args))
            except StopAsyncIteration:
                self._end()
                raise
            except BaseException as exc:
                self._end(exc)
                raise

    async def asend(self, value: Any) -> Any:
        return await self._astep("asend", value)

    async def athrow(self, *args: Any) -> Any:
        return await self._astep("athrow", *args)

    async def aclose(self) -> None:
        if self.closed:
            return
        if self.observation is None:
            await self.iterator.aclose()
            self.closed = True
            return
        with self._activate():
            try:
                await self.iterator.aclose()
            except BaseException as exc:
                self._end(exc)
                raise
            else:
                self._end(GeneratorExit())


@overload
def observe(func: F) -> F: ...


@overload
def observe(
    func: None = None,
    *,
    name: str | None = None,
    as_type: ObservationType = "span",
    capture_input: bool = True,
    capture_output: bool = True,
    client: Datool | None = None,
) -> Callable[[F], F]: ...


def observe(
    func: F | None = None,
    *,
    name: str | None = None,
    as_type: ObservationType = "span",
    capture_input: bool = True,
    capture_output: bool = True,
    client: Datool | None = None,
) -> Any:
    """Capture ordinary functions, coroutines, generators, and async generators."""

    def decorate(fn: F) -> F:
        signature = inspect.signature(fn)

        def setup(args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[Datool, dict[str, Any]]:
            selected = client or get_client()
            options: dict[str, Any] = {"name": name or fn.__name__, "as_type": as_type}
            if capture_input:
                bound = signature.bind(*args, **kwargs)
                options["input"] = {
                    k: v for k, v in bound.arguments.items() if k not in {"self", "cls"}
                }
            return selected, options

        if inspect.isasyncgenfunction(fn) or inspect.isgeneratorfunction(fn):

            @wraps(fn)
            def stream(*args: Any, **kwargs: Any) -> Any:
                selected, options = setup(args, kwargs)
                wrapper = _AsyncStream if inspect.isasyncgenfunction(fn) else _Stream
                return wrapper(fn(*args, **kwargs), selected, options, capture_output)

            return stream  # type: ignore[return-value]
        if inspect.iscoroutinefunction(fn):

            @wraps(fn)
            async def asynchronous(*args: Any, **kwargs: Any) -> Any:
                selected, options = setup(args, kwargs)
                with selected.start_as_current_observation(**options) as observation:
                    result = await fn(*args, **kwargs)
                    if capture_output:
                        _update(observation, output=result)
                    return result

            return asynchronous  # type: ignore[return-value]

        @wraps(fn)
        def synchronous(*args: Any, **kwargs: Any) -> Any:
            selected, options = setup(args, kwargs)
            with selected.start_as_current_observation(**options) as observation:
                result = fn(*args, **kwargs)
                if capture_output:
                    _update(observation, output=result)
                return result

        return synchronous  # type: ignore[return-value]

    return decorate(func) if func is not None else decorate
