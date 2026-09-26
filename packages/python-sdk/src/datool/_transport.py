"""Datool's JSON lifecycle protocol (not OTLP), with durable receipt barriers."""

from __future__ import annotations

import json
import random
import threading
import time
from collections import deque
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import httpx


class DatoolError(RuntimeError):
    """A configuration, API, or delivery failure. Never includes HTTP response bodies."""


class DatoolHTTPError(DatoolError):
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"Datool request failed (HTTP {status_code})")


class Transport:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        project_id: str,
        timeout: float,
        retries: int,
        max_queue_size: int,
        http_client: httpx.Client | None,
    ) -> None:
        url = urlsplit(base_url)
        if (
            url.scheme not in {"http", "https"}
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in {"", "/"}
        ):
            raise ValueError("base_url must be an HTTP(S) origin without credentials")
        if timeout <= 0 or retries < 0 or max_queue_size < 1:
            raise ValueError("Invalid timeout, retries, or max_queue_size")
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "authorization": f"Bearer {api_key}",
            "x-project-id": project_id,
            "content-type": "application/json",
            "user-agent": "datool-python/0.1.0",
        }
        self.timeout, self.retries, self.capacity = timeout, retries, max_queue_size
        self.http = http_client or httpx.Client()
        self.owns_http = http_client is None
        self.cv = threading.Condition()
        self.pending: deque[tuple[int, str]] = deque()
        self.sequence = self.accepted = 0
        self.previous_id: str | None = None
        self.failure: DatoolError | None = None
        self.permanent_failure: DatoolError | None = None
        self.stopped = False
        self.worker = threading.Thread(target=self._run, name="datool-export", daemon=True)
        self.worker.start()

    def request(
        self,
        path: str,
        method: str = "GET",
        body: Any = None,
        *,
        retryable: bool = False,
        deadline: float | None = None,
    ) -> Any:
        parsed = urlsplit(path)
        if (
            not path.startswith("/api/")
            or parsed.netloc
            or parsed.scheme
            or parsed.fragment
            or "\\" in unquote(path)
            or any(p in {".", ".."} for p in unquote(parsed.path).split("/"))
        ):
            raise ValueError("Expected a Datool /api/ path")
        method = method.upper()
        if method not in {"GET", "POST", "PATCH", "PUT", "DELETE"}:
            raise ValueError("Unsupported HTTP method")
        content = None if body is None else json.dumps(body, allow_nan=False)
        return self._send(path, method, content, retryable or method == "GET", deadline)

    def _send(
        self,
        path: str,
        method: str,
        content: str | None,
        retryable: bool,
        deadline: float | None = None,
    ) -> Any:
        attempts = self.retries if retryable else 0
        for attempt in range(attempts + 1):
            remaining = (
                self.timeout if deadline is None else min(self.timeout, deadline - time.monotonic())
            )
            if remaining <= 0:
                raise DatoolError("Datool flush timed out before persistence was confirmed")
            delay = min(0.1 * 2**attempt, 5.0) * random.uniform(0.8, 1.2)
            try:
                response = self.http.request(
                    method,
                    self.base_url + path,
                    headers=self.headers,
                    content=content,
                    timeout=remaining,
                    follow_redirects=False,
                )
            except httpx.TransportError:
                error: DatoolError = DatoolError("Datool network request failed")
            else:
                if response.is_success:
                    try:
                        payload = response.json()
                    except ValueError:
                        raise DatoolError("Datool returned invalid JSON") from None
                    if not isinstance(payload, dict) or "data" not in payload:
                        raise DatoolError("Datool returned an invalid response envelope")
                    return payload["data"]
                error = DatoolHTTPError(response.status_code)
                if response.status_code not in {408, 429, 500, 502, 503, 504}:
                    raise error
                try:
                    delay = max(delay, min(float(response.headers.get("retry-after", "0")), 60))
                except ValueError:
                    pass
            if attempt == attempts:
                raise error from None
            if deadline is not None:
                delay = min(delay, max(0, deadline - time.monotonic()))
            time.sleep(delay)
        raise AssertionError("unreachable")

    def enqueue(self, path: str, method: str, body: dict[str, Any]) -> None:
        with self.cv:
            if self.stopped:
                self.permanent_failure = DatoolError(
                    "Datool is shut down; telemetry was not queued"
                )
                return
            if len(self.pending) >= self.capacity:
                self.permanent_failure = DatoolError(
                    "Datool export queue is full; telemetry was lost"
                )
                return
            event_id = str(uuid4())
            # Serialize once: all retries must have the same ID AND exactly the same payload.
            event = json.dumps(
                {
                    "id": event_id,
                    "previousId": self.previous_id,
                    "path": path,
                    "method": method,
                    "body": body,
                },
                allow_nan=False,
            )
            self.sequence += 1
            self.previous_id = event_id
            self.pending.append((self.sequence, event))
            self.cv.notify_all()

    def _run(self) -> None:
        while True:
            with self.cv:
                self.cv.wait_for(lambda: self.stopped or (self.pending and self.failure is None))
                if self.stopped:
                    return
                seq, content = self.pending[0]
            try:
                self._send("/api/ingest", "POST", content, True)
            except Exception:
                # Do not retain arbitrary transport exceptions containing request secrets.
                with self.cv:
                    self.failure = DatoolError(
                        "Datool export failed; pending events retained for flush retry"
                    )
                    self.cv.notify_all()
            else:
                with self.cv:
                    self.pending.popleft()
                    self.accepted = seq
                    self.cv.notify_all()

    def flush(self, timeout: float = 60) -> None:
        if timeout <= 0:
            raise ValueError("flush timeout must be positive")
        deadline = time.monotonic() + timeout
        with self.cv:
            if self.permanent_failure:
                raise self.permanent_failure
            target, event_id = self.sequence, self.previous_id
            if not event_id:
                return
            self.failure = None
            self.cv.notify_all()
            while self.accepted < target:
                if self.failure:
                    raise self.failure
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.stopped:
                    raise DatoolError("Datool flush timed out; pending events retained")
                self.cv.wait(remaining)
        while time.monotonic() < deadline:
            state = self.request(f"/api/ingest?eventId={event_id}", deadline=deadline)
            if not isinstance(state, dict):
                raise DatoolError("Datool returned an invalid ingestion receipt")
            if state.get("status") == "saved":
                return
            if state.get("status") == "failed":
                raise DatoolError(
                    "Datool ingestion failed; event retained on the server for replay"
                )
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        raise DatoolError("Datool flush timed out before persistence was confirmed")

    def shutdown(self, timeout: float = 60) -> None:
        if self.stopped:
            return
        # Keep the worker/client usable after a failed flush so callers can recover and retry.
        self.flush(timeout)
        with self.cv:
            self.stopped = True
            self.cv.notify_all()
        self.worker.join()
        if self.owns_http:
            self.http.close()
