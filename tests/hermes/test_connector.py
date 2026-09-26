import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("datool_hermes", ROOT / "integrations/hermes/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class ConnectorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = dict(base_url="http://localhost:3000", project_id="project", api_key="secret-test-key", state_dir=self.tmp.name)
        self.c = plugin.Connector(self.config, background=False)
        self.ids = dict(session_id="session", turn_id="turn", task_id="task", user_message="hello", model="model")

    def tearDown(self):
        self.c.outbox.close()
        self.tmp.cleanup()

    def events(self):
        return [json.loads(row[0]) for row in self.c.outbox.db.execute("select payload from events order by seq")]

    def handle(self, hook, **kwargs):
        self.c.handle(hook, **{**self.ids, **kwargs})

    def test_parallel_tools_and_usage_reconcile_with_cached_tokens(self):
        self.handle("pre_llm_call")
        self.handle("pre_api_request", api_request_id="request", request={"body": {"api_key": "private", "messages": ["secret-test-key"]}})
        self.handle("post_api_request", api_request_id="request", response={"assistant_message": "tools"},
                    usage={"input_tokens": 10, "prompt_tokens": 35, "cache_read_tokens": 20, "cache_write_tokens": 5,
                           "output_tokens": 7, "total_tokens": 42, "reasoning_tokens": 2})
        for call in ["a", "b"]:
            self.handle("pre_tool_call", tool_call_id=call, tool_name="terminal", api_request_id="request", args={"command": call})
        self.handle("post_tool_call", tool_call_id="b", tool_name="terminal", result='{"exit_code":7}', status="error")
        self.handle("post_tool_call", tool_call_id="a", tool_name="terminal", result='{"exit_code":0,"output":"done"}', status="ok")
        self.handle("post_llm_call", assistant_response="recovered")
        self.handle("on_session_end", completed=True, failed=False)
        events = self.events()
        self.assertNotIn("secret-test-key", json.dumps(events))
        self.assertNotIn('"private"', json.dumps(events))
        final = events[-1]["body"]
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["attributes"]["usage.input_tokens"], 35)
        self.assertEqual(final["attributes"]["usage.total_tokens"], 42)
        self.assertEqual(final["attributes"]["usage.llm_calls"], 1)
        tool_ends = [e["body"] for e in events if e["method"] == "PATCH" and "tool.name" in e["body"]["attributes"]]
        self.assertEqual([s["status"] for s in tool_ends], ["errored", "completed"])
        count = len(events)
        self.handle("on_session_end", completed=True)
        self.assertEqual(len(self.events()), count)

    def test_retry_error_missing_usage_and_cancelled_turn(self):
        self.handle("pre_api_request", api_request_id="first")
        self.handle("api_request_error", api_request_id="first", error={"type": "RateLimit", "message": "retry"}, retryable=True)
        self.handle("pre_api_request", api_request_id="retry")
        self.handle("on_session_end", completed=False, interrupted=True)
        events = self.events()
        self.assertEqual(events[-1]["body"]["status"], "cancelled")
        self.assertEqual(events[-1]["body"]["attributes"]["usage.status"], "missing")
        self.assertNotIn("usage.input_tokens", events[-1]["body"]["attributes"])
        self.assertEqual(events[-1]["body"]["attributes"]["usage.llm_calls"], 2)

    def test_terminal_api_failure_finishes_trace_without_session_end(self):
        self.handle("pre_api_request", api_request_id="bad")
        self.handle("api_request_error", api_request_id="bad", retryable=False,
                    error={"type": "BadRequest", "message": "invalid model"})
        self.assertEqual(self.events()[-1]["body"]["status"], "errored")
        self.assertEqual(self.c.turns, {})
        count = len(self.events())
        self.handle("on_session_end", failed=True)
        self.assertEqual(len(self.events()), count)

    def test_duplicate_tool_completion_does_not_double_count(self):
        self.handle("pre_tool_call", tool_call_id="same", tool_name="terminal")
        self.handle("post_tool_call", tool_call_id="same", tool_name="terminal", result="ok")
        count = len(self.events())
        self.handle("post_tool_call", tool_call_id="same", tool_name="terminal", result="ok")
        self.assertEqual(len(self.events()), count)

    def test_content_disabled(self):
        self.c.capture_content = False
        self.handle("pre_llm_call", user_message="PRIVATE PROMPT")
        self.handle("pre_tool_call", tool_call_id="a", args={"secret": "PRIVATE ARG"})
        self.assertNotIn("PRIVATE", json.dumps(self.events()))
        trace = next(e["body"] for e in self.events() if e["path"] == "/api/traces")
        self.assertEqual(trace["spans"][0]["input"], {"capture": "disabled"})

    def test_root_agent_captures_the_same_redacted_input_as_its_trace(self):
        self.handle("pre_llm_call", user_message="hello secret-test-key")
        trace = next(e["body"] for e in self.events() if e["path"] == "/api/traces")
        self.assertEqual(trace["input"], "hello <redacted>")
        self.assertEqual(trace["spans"][0]["input"], trace["input"])

    def test_outbox_restarts_and_waits_for_database_receipt(self):
        self.handle("pre_llm_call")
        original = self.events()[0]
        sent = []
        def unavailable(path, payload=None):
            raise RuntimeError("offline")
        self.c.outbox.request = unavailable
        with self.assertRaises(RuntimeError):
            self.c.outbox.deliver_one()
        self.assertEqual(self.c.outbox.status()["pending"], 2)
        self.c.outbox.close()
        self.c.outbox = plugin.Outbox(self.config)
        def queued(path, payload=None):
            if payload:
                sent.append(payload)
            return {"status": "queued"}
        self.c.outbox.request = queued
        self.assertFalse(self.c.outbox.deliver_one())
        self.assertEqual(self.c.outbox.status()["pending"], 2)
        self.c.outbox.request = lambda path, payload=None: {"status": "saved"}
        self.assertTrue(self.c.outbox.deliver_one())
        self.assertEqual(self.c.outbox.status()["pending"], 1)
        self.assertEqual(sent[0], original)
        self.assertIsNone(self.c.outbox.db.execute("select payload from events where id=?", (original["id"],)).fetchone()[0])

    def test_reject_destination_change_and_insecure_remote(self):
        with self.assertRaisesRegex(ValueError, "another Datool destination"):
            plugin.Outbox({**self.config, "project_id": "different"})
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            plugin.Outbox({**self.config, "base_url": "http://example.com"})

    def test_two_turns_share_one_session_and_independent_chains(self):
        self.handle("pre_llm_call")
        self.handle("on_session_end", completed=True)
        self.handle("pre_llm_call", turn_id="second")
        events = self.events()
        sessions = [e for e in events if e["path"] == "/api/sessions"]
        traces = [e for e in events if e["path"] == "/api/traces"]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(len(traces), 2)
        self.assertEqual(traces[0]["body"]["sessionId"], traces[1]["body"]["sessionId"])
        self.assertNotEqual(traces[0]["body"]["id"], traces[1]["body"]["id"])
        self.assertEqual(traces[1]["previousId"], sessions[0]["id"])


if __name__ == "__main__":
    unittest.main()
