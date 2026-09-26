"""Native Hermes plugin. Python standard library only; no monkeypatching.

Hook callbacks journal lifecycle events locally. A background sender waits for
Datool's PostgreSQL receipt before removing content from the outbox.
"""
from __future__ import annotations

import argparse
import atexit
import getpass
import json
import logging
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

log = logging.getLogger("hermes.datool")
NAMESPACE = uuid.UUID("23e5f2e8-1cf3-440b-bb2c-348dd88d0db5")
HOOKS = (
    "pre_llm_call", "post_llm_call", "pre_api_request", "post_api_request",
    "api_request_error", "pre_tool_call", "post_tool_call", "on_session_end",
    "on_session_finalize",
)


def stable(*parts):
    return str(uuid.uuid5(NAMESPACE, json.dumps(parts, separators=(",", ":"))))


def timestamp(value=None):
    return datetime.fromtimestamp(value if value is not None else time.time(), timezone.utc).isoformat()


def hermes_home():
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except ImportError:
        return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def settings():
    state = Path(os.environ.get("DATOOL_HERMES_STATE_DIR", hermes_home() / "datool"))
    config_path = state / "config.json"
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    for key in ("base_url", "project_id", "api_key"):
        if os.environ.get("DATOOL_" + key.upper()):
            config[key] = os.environ["DATOOL_" + key.upper()]
    config["state_dir"] = state
    config["capture_content"] = os.environ.get(
        "DATOOL_HERMES_CAPTURE_CONTENT", str(config.get("capture_content", True))
    ).lower() in ("true", "1", "yes")
    return config


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Credentials must never be forwarded to another origin.


class DatoolHTTPError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Datool HTTP {status}; event retained for retry")


class Outbox:
    def __init__(self, config):
        self.base_url = str(config.get("base_url", "")).rstrip("/")
        parsed = urlsplit(self.base_url)
        if (parsed.scheme not in ("https", "http") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("DATOOL_BASE_URL must be a Datool origin without credentials or a path")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote Datool connections require HTTPS")
        self.project_id = str(config.get("project_id", "")).strip()
        self.api_key = str(config.get("api_key", "")).strip()
        if not self.project_id or not self.api_key:
            raise ValueError("Configure DATOOL_PROJECT_ID and DATOOL_API_KEY first")
        self.directory = private_directory(Path(config["state_dir"]))
        path = self.directory / "outbox.sqlite3"
        # Pre-create with private permissions before sqlite writes any content.
        fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        path.chmod(0o600)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, timeout=10, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                payload TEXT, saved INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS streams (key TEXT PRIMARY KEY, last_id TEXT NOT NULL);
        """)
        destination = json.dumps([self.base_url, self.project_id])
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO metadata VALUES ('destination', ?)", (destination,))
        if self.db.execute("SELECT value FROM metadata WHERE key='destination'").fetchone()[0] != destination:
            self.db.close()
            raise ValueError("Outbox belongs to another Datool destination; use a new state directory")
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.thread = None
        self.last_error = None
        self.opener = build_opener(NoRedirect)

    def enqueue(self, stream, path, body, method="POST", *, event_id=None, predecessor=None):
        event_id = event_id or str(uuid.uuid4())
        with self.lock, self.db:
            # Deterministic creation events (sessions/turns) keep their original payload.
            if self.db.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
                return event_id
            previous = self.db.execute("SELECT last_id FROM streams WHERE key=?", (stream,)).fetchone()
            event = {"id": event_id, "previousId": previous[0] if previous else predecessor,
                     "path": path, "method": method, "body": body}
            self.db.execute("INSERT INTO events(id,payload) VALUES (?,?)", (
                event_id, json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":"))))
            self.db.execute("INSERT OR REPLACE INTO streams VALUES (?,?)", (stream, event_id))
        self.wake.set()
        return event_id

    def request(self, path, payload=None):
        req = Request(self.base_url + path,
                      data=json.dumps(payload).encode() if payload is not None else None,
                      headers={"Authorization": "Bearer " + self.api_key,
                               "x-project-id": self.project_id, "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=5) as response:
                value = json.load(response)
        except HTTPError as exc:
            status = exc.code
            exc.close()
            raise DatoolHTTPError(status) from None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError("Datool unreachable; event retained for retry") from None
        if not isinstance(value, dict) or "data" not in value:
            raise RuntimeError("Invalid Datool response; event retained for retry")
        return value["data"]

    def deliver_one(self):
        with self.lock:
            row = self.db.execute("SELECT id,payload FROM events WHERE saved=0 ORDER BY seq LIMIT 1").fetchone()
        if not row:
            return False
        event_id, payload = row
        self.request("/api/ingest", json.loads(payload))
        receipt = self.request("/api/ingest?eventId=" + event_id)
        if receipt.get("status") == "failed":
            raise RuntimeError("Datool ingestion failed; event retained. Check worker and project limits")
        if receipt.get("status") != "saved":
            return False
        with self.lock, self.db:
            self.db.execute("UPDATE events SET saved=1,payload=NULL WHERE id=?", (event_id,))
        return True

    def status(self):
        with self.lock:
            pending, saved = self.db.execute(
                "SELECT coalesce(sum(saved=0),0),coalesce(sum(saved=1),0) FROM events"
            ).fetchone()
            error = self.db.execute("SELECT value FROM metadata WHERE key='last_error'").fetchone()
        return {"destination": self.base_url, "projectId": self.project_id,
                "pending": pending, "saved": saved, "lastError": error[0] if error and pending else None}

    def run(self):
        delay = 0.1
        while not self.stop.is_set():
            try:
                progressed = self.deliver_one()
                self.last_error = None
                with self.lock, self.db:
                    self.db.execute("DELETE FROM metadata WHERE key='last_error'")
                delay = 0.1
                if progressed:
                    continue
            except Exception as exc:
                message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
                if message != self.last_error:
                    log.warning("Datool: %s", message)
                self.last_error = message
                with self.lock, self.db:
                    self.db.execute("INSERT OR REPLACE INTO metadata VALUES ('last_error', ?)", (message,))
                delay = min(max(delay * 2, 1), 30)
            self.wake.wait(delay)
            self.wake.clear()

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, name="datool-export", daemon=True)
            self.thread.start()

    def flush(self, timeout=30):
        self.start()
        deadline = time.monotonic() + timeout
        self.wake.set()
        while self.status()["pending"] and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.status()["pending"]:
            raise RuntimeError("Datool events remain in the durable outbox; run datool flush to retry")
        return self.status()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=11)
        if not self.thread or not self.thread.is_alive():
            self.db.close()


class Connector:
    def __init__(self, config, *, background=True):
        self.outbox = Outbox(config)
        self.capture_content = config.get("capture_content", True)
        self.secrets = tuple(v for v in (config.get("api_key"), os.environ.get("OPENAI_API_KEY")) if v)
        self.turns = {}
        self.lock = threading.RLock()
        if background:
            self.outbox.start()

    def safe(self, value):
        if isinstance(value, dict):
            return {str(k): ("<redacted>" if str(k).lower().replace("-", "_") in
                    ("api_key", "authorization", "proxy_authorization", "cookie", "set_cookie", "password", "secret", "access_token", "refresh_token")
                    or str(k).lower().endswith("_api_key") else self.safe(v)) for k, v in value.items()}
        if isinstance(value, (tuple, list)):
            return [self.safe(v) for v in value]
        if isinstance(value, str):
            for secret in self.secrets:
                value = value.replace(secret, "<redacted>")
            return value
        if isinstance(value, float) and not math.isfinite(value):
            return None
        if value is None or isinstance(value, (int, float, bool)):
            return value
        # Never serialize an arbitrary SDK/client object with its private state.
        return "<" + type(value).__name__ + ">"

    def content(self, value):
        return self.safe(value) if self.capture_content else {"capture": "disabled"}

    def emit(self, turn, path, body, method="POST", **kwargs):
        return self.outbox.enqueue(turn["id"], path, self.safe(body), method, **kwargs)

    def turn(self, data):
        sid = str(data.get("session_id") or data.get("task_id") or "")
        tid = str(data.get("turn_id") or "")
        if not sid or not tid:
            raise ValueError("Hermes hook omitted session/turn identity; requires Hermes >=0.21.3")
        key = (sid, tid)
        if key in self.turns:
            return self.turns[key]
        project = self.outbox.project_id
        session_id = stable(project, "session", sid)
        trace_id = stable(project, "turn", sid, tid)
        with self.outbox.lock:
            if self.outbox.db.execute("SELECT 1 FROM events WHERE id=?", (stable(trace_id, "finish"),)).fetchone():
                return {"closed": True}
        attrs = {"integration": "hermes", "hermes.session_id": sid, "hermes.turn_id": tid,
                 "hermes.task_id": data.get("task_id", ""), "hermes.platform": data.get("platform", ""),
                 "hermes.parent_session_id": data.get("parent_session_id", ""),
                 "hermes.capture_content": self.capture_content,
                 "hermes.content_source": "native_plugin_hooks", "cost.status": "missing"}
        turn = {"id": trace_id, "root": stable(trace_id, "agent"), "attrs": attrs,
                "spans": {}, "llms": {}, "output": None, "closed": False}
        self.turns[key] = turn
        session_event = self.outbox.enqueue(session_id, "/api/sessions", {
            "id": session_id, "name": "Hermes " + sid[:160],
            "attributes": {"integration": "hermes", "hermes.session_id": sid}},
            event_id=stable(session_id, "create"))
        started = timestamp(data.get("started_at"))
        self.emit(turn, "/api/traces", {
            "id": trace_id, "sessionId": session_id, "name": "Hermes turn", "operation": "hermes.agent",
            "input": self.content(data.get("user_message")), "startedAt": started,
            "status": "running", "attributes": attrs,
            "spans": [{"id": turn["root"], "kind": "agent", "name": "Hermes agent",
                       "input": self.content(data.get("user_message")),
                       "startedAt": started, "status": "running", "attributes": attrs}]},
            event_id=stable(trace_id, "create"), predecessor=session_event)
        return turn

    def span(self, turn, data, kind):
        source = str(data.get("api_request_id") if kind == "llm" else data.get("tool_call_id") or "")
        if not source:
            raise ValueError("Hermes hook omitted request/tool identity")
        span_id = stable(turn["id"], kind, source)
        if span_id not in turn["spans"]:
            attrs = {"integration": "hermes", "hermes.api_request_id": data.get("api_request_id", "")}
            if kind == "llm":
                attrs.update({"model": data.get("model", ""), "provider": data.get("provider", ""),
                              "gen_ai.request.model": data.get("model", ""),
                              "hermes.api_mode": data.get("api_mode", ""),
                              "hermes.retry_count": data.get("retry_count", 0),
                              "hermes.payload_may_be_truncated": True})
                input_value = data.get("request")
                name = "Model: " + str(data.get("model", "unknown"))
            else:
                attrs.update({"hermes.tool_call_id": source, "tool.name": data.get("tool_name", "tool")})
                input_value = data.get("args")
                name = "Tool: " + str(data.get("tool_name", "tool"))
            started_at = data.get("started_at")
            if kind == "tool" and started_at is None and data.get("duration_ms") is not None:
                started_at = time.time() - max(0, data["duration_ms"]) / 1000
            state = {"id": span_id, "kind": kind, "attrs": attrs, "ended": False}
            turn["spans"][span_id] = state
            # A tool's producing request is a causal link, not a timing parent.
            self.emit(turn, f'/api/traces/{turn["id"]}/spans', {
                "id": span_id, "parentId": turn["root"], "kind": kind, "name": name[:200],
                "startedAt": timestamp(started_at), "status": "running",
                "input": self.content(input_value), "attributes": attrs},
                event_id=stable(span_id, "create"))
        return turn["spans"][span_id]

    def finish_span(self, turn, span, data, status, output):
        if span["ended"]:
            return
        span["ended"] = True
        self.emit(turn, f'/api/spans/{span["id"]}', {
            "status": status, "endedAt": timestamp(data.get("ended_at")),
            "output": self.content(output), "attributes": span["attrs"]}, "PATCH")

    def handle(self, hook, **data):
        with self.lock:
            if hook == "on_session_finalize":
                for (sid, _), turn in list(self.turns.items()):
                    if sid == data.get("session_id") and not turn["closed"]:
                        self.finish_turn(turn, {"interrupted": True, "turn_exit_reason": data.get("reason", "session finalized")})
                return
            turn = self.turn(data)
            if turn["closed"]:
                return
            if hook == "pre_llm_call":
                return
            if hook == "post_llm_call":
                turn["output"] = self.content(data.get("assistant_response"))
                return
            if hook in ("pre_api_request", "post_api_request", "api_request_error"):
                span = self.span(turn, data, "llm")
                if hook == "pre_api_request":
                    return
                attrs = span["attrs"]
                if hook == "api_request_error":
                    attrs.update({"error.type": (data.get("error") or {}).get("type", "api_error"),
                                  "error.message": (data.get("error") or {}).get("message", ""),
                                  "hermes.retryable": data.get("retryable"), "usage.status": "missing"})
                    self.finish_span(turn, span, data, "errored", data.get("error"))
                else:
                    usage = data.get("usage")
                    attrs["usage.status"] = "complete" if usage else "missing"
                    if isinstance(usage, dict) and usage:
                        # Hermes input_tokens is UNCACHED; Datool input_tokens includes cache buckets.
                        for target, source in (("input_tokens", "prompt_tokens"), ("output_tokens", "output_tokens"),
                                               ("total_tokens", "total_tokens"), ("cache_read_tokens", "cache_read_tokens"),
                                               ("cache_write_tokens", "cache_write_tokens"), ("reasoning_tokens", "reasoning_tokens")):
                            if isinstance(usage.get(source), int) and usage[source] >= 0:
                                attrs["usage." + target] = usage[source]
                    attrs["gen_ai.response.model"] = data.get("response_model") or data.get("model", "")
                    attrs["gen_ai.response.finish_reason"] = data.get("finish_reason")
                    if data.get("first_chunk_at") is not None and data.get("started_at") is not None:
                        attrs["latency.ttft_ms"] = max(0, (data["first_chunk_at"] - data["started_at"]) * 1000)
                    self.finish_span(turn, span, data, "completed", data.get("response"))
                turn["llms"][span["id"]] = attrs
                if hook == "api_request_error" and data.get("retryable") is False:
                    turn["output"] = self.content(data.get("error"))
                    self.finish_turn(turn, {"failed": True, "turn_exit_reason": "non_retryable_api_error"})
            elif hook in ("pre_tool_call", "post_tool_call"):
                span = self.span(turn, data, "tool")
                if hook == "pre_tool_call":
                    return
                state = data.get("status")
                result = data.get("result")
                if isinstance(result, str):
                    try:
                        result = json.loads(result)
                    except ValueError:
                        pass
                failure = state in ("error", "errored", "failed", "blocked", "denied") or bool(data.get("error_type"))
                if isinstance(result, dict):
                    failure = failure or bool(result.get("error")) or result.get("exit_code", 0) not in (0, None)
                status = "cancelled" if state == "cancelled" else "errored" if failure else "completed"
                span["attrs"].update({"hermes.tool_status": state, "hermes.duration_ms": data.get("duration_ms")})
                if failure:
                    span["attrs"].update({"error.type": data.get("error_type") or "tool_error",
                                           "error.message": data.get("error_message") or "Tool reported a failure"})
                self.finish_span(turn, span, data, status, result)
            elif hook == "on_session_end":
                self.finish_turn(turn, data)

    def finish_turn(self, turn, data):
        if turn["closed"]:
            return
        status = "cancelled" if data.get("interrupted") else "errored" if data.get("failed") or data.get("completed") is False else "completed"
        for span in turn["spans"].values():
            if not span["ended"]:
                span["attrs"]["hermes.incomplete"] = True
                self.finish_span(turn, span, {}, "cancelled", {"reason": "turn ended before terminal hook"})
                if span["kind"] == "llm":
                    turn["llms"][span["id"]] = span["attrs"]
        attrs = dict(turn["attrs"])
        llms = list(turn["llms"].values())
        known = sum("usage.input_tokens" in a and "usage.output_tokens" in a for a in llms)
        attrs.update({"hermes.turn_exit_reason": data.get("turn_exit_reason", ""),
                      "usage.llm_calls": len(llms), "usage.known_llm_calls": known,
                      "usage.source": "descendant_llm_sum",
                      "usage.status": "missing" if not known else "complete" if known == len(llms) else "partial",
                      "models": sorted({a.get("model", "") for a in llms})})
        for key in ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"):
            values = [a["usage." + key] for a in llms if "usage." + key in a]
            if values:
                attrs["usage." + key] = sum(values)
        if len(attrs["models"]) == 1:
            attrs["model"] = attrs["models"][0]
        body = {"status": status, "endedAt": timestamp(), "output": turn["output"], "attributes": attrs}
        self.emit(turn, f'/api/spans/{turn["root"]}', body, "PATCH")
        self.emit(turn, f'/api/traces/{turn["id"]}', body, "PATCH", event_id=stable(turn["id"], "finish"))
        turn["closed"] = True
        # The durable finish event is the tombstone; no unbounded in-memory session history.
        self.turns.pop((turn["attrs"]["hermes.session_id"], turn["attrs"]["hermes.turn_id"]), None)

    def callback(self, hook):
        def observe(**data):
            try:
                self.handle(hook, **data)
            except Exception as exc:
                # Hook failures must never stop Hermes, but must be visible to operators.
                log.error("Datool capture failed for %s (%s); inspect plugin configuration/disk", hook, type(exc).__name__)
        return observe

    def shutdown(self):
        try:
            self.outbox.flush(timeout=3)
        except RuntimeError:
            log.warning("Datool has pending events; they will replay when Hermes starts again")
        finally:
            self.outbox.close()


def configure():
    config = settings()
    config["base_url"] = os.environ.get("DATOOL_BASE_URL") or input("Datool URL: ").strip()
    config["project_id"] = os.environ.get("DATOOL_PROJECT_ID") or input("Datool project ID: ").strip()
    config["api_key"] = os.environ.get("DATOOL_API_KEY") or getpass.getpass("Datool API key (traces:write): ").strip()
    outbox = Outbox(config)  # Validate origin, destination binding and required credentials before saving.
    try:
        # A receipt lookup authenticates traces:write without creating a test trace.
        # A missing random event is expected; auth/worker endpoint failures are not.
        try:
            outbox.request("/api/ingest?eventId=" + str(uuid.uuid4()))
        except DatoolHTTPError as exc:
            if exc.status != 404:
                raise
    finally:
        outbox.close()
    path = private_directory(config.pop("state_dir")) / "config.json"
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(config, f, indent=2)
    temp.replace(path)
    print("Connection verified. Tracing includes prompts and tool inputs/outputs; protect the Datool project accordingly.")


def command(args):
    if args.action == "configure":
        configure()
        return
    outbox = Outbox(settings())
    try:
        print(json.dumps(outbox.flush(args.timeout) if args.action == "flush" else outbox.status(), indent=2))
    finally:
        outbox.close()


def setup_parser(parser):
    parser.add_argument("action", choices=("configure", "status", "flush"))
    parser.add_argument("--timeout", type=float, default=30)


def register(ctx):
    ctx.register_cli_command("datool", "Configure or inspect Datool tracing", setup_parser, command)
    config = settings()
    if not all(config.get(k) for k in ("base_url", "project_id", "api_key")):
        log.warning("Datool tracing is not configured. Run: hermes datool configure")
        return
    connector = Connector(config)
    for hook in HOOKS:
        ctx.register_hook(hook, connector.callback(hook))
    atexit.register(connector.shutdown)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Datool Hermes tracing")
    setup_parser(parser)
    command(parser.parse_args())
