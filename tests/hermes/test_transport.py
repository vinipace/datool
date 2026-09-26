"""Actual HTTP boundary tests: retry payload identity, receipt gating and redirects."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import tempfile
import unittest

import test_connector

plugin = test_connector.plugin


class TransportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = dict(project_id="project", api_key="secret-test-key")

    def tearDown(self):
        self.tmp.cleanup()

    def test_http_failure_restart_receipt_and_duplicate_delivery(self):
        seen = []
        state = {"offline": True, "committed": False, "redirect": False}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.reply(503 if state["offline"] else 202, {"status": "queued"})
            def do_GET(self):
                if state["redirect"]:
                    self.send_response(302)
                    self.send_header("Location", "/unexpected")
                    self.end_headers()
                    return
                self.reply(200, {"status": "saved" if state["committed"] else "waiting"})
            def reply(self, status, data):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": data}).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = {**self.config, "base_url": f"http://127.0.0.1:{server.server_port}",
                  "state_dir": str(Path(self.tmp.name) / "http")}
        box = plugin.Outbox(config)
        try:
            box.enqueue("stream", "/api/sessions", {"id": "session"})
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                box.deliver_one()
            self.assertEqual(box.status()["pending"], 1)
            box.close()
            box = plugin.Outbox(config)
            state["offline"] = False
            self.assertFalse(box.deliver_one())
            self.assertEqual(box.status()["pending"], 1)  # HTTP 202 is not a receipt.
            state["committed"] = True
            self.assertTrue(box.deliver_one())
            self.assertEqual(box.status()["pending"], 0)
            self.assertTrue(all(e == seen[0] for e in seen))
            state["redirect"] = True
            with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
                box.request("/api/ingest?eventId=" + seen[0]["id"])
        finally:
            box.close()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
