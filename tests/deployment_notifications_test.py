import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("notifications", Path(__file__).parents[1] / "ops/notify-deployment.py")
notifications = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifications)


class DeploymentNotificationsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(notifications.os.environ, {"SLACK_BOT_TOKEN": "fixture-secret", "SLACK_DEPLOYMENTS_CHANNEL": "CFIXTURE"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.args = SimpleNamespace(status="started", app="Example", environment="production", deployment_id="run-1-attempt-2",
                                    commit="a" * 40, url="https://ci.example.test/run/1", state_file=f"{self.directory.name}/thread.json")

    def test_success_and_failure_reply_to_the_acknowledged_parent(self):
        for terminal in ("succeeded", "failed"):
            with self.subTest(terminal=terminal):
                Path(self.args.state_file).unlink(missing_ok=True)
                with patch.object(notifications, "post", return_value="123.456") as send:
                    self.args.status = "started"
                    notifications.notify(self.args, send)
                    notifications.notify(self.args, send)
                    self.assertEqual(send.call_count, 1)
                    self.args.status = terminal
                    notifications.notify(self.args, send)
                    notifications.notify(self.args, send)
                    self.assertEqual(send.call_count, 2)
                    self.assertEqual(send.call_args.args[3], "123.456")
                    self.assertIn(terminal, send.call_args.args[2])
                    state = json.loads(Path(self.args.state_file).read_text())
                    self.assertNotIn("fixture-secret", json.dumps(state))
                    self.assertEqual(Path(self.args.state_file).stat().st_mode & 0o777, 0o600)

    def test_lost_parent_acknowledgement_never_creates_a_second_thread(self):
        with patch.object(notifications, "post", side_effect=TimeoutError) as send:
            with self.assertRaises(TimeoutError):
                notifications.notify(self.args, send)
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                notifications.notify(self.args, send)
            self.args.status = "failed"
            with self.assertRaisesRegex(RuntimeError, "No acknowledged parent"):
                notifications.notify(self.args, send)
            self.assertEqual(send.call_count, 1)

    def test_state_cannot_mix_deployments_or_channels(self):
        notifications.notify(self.args, lambda *args: "123.456")
        self.args.deployment_id = "other-deployment"
        with self.assertRaises(ValueError):
            notifications.notify(self.args, lambda *args: self.fail("Must not send"))

    def test_missing_deployment_channel_disables_shared_bot_notifications(self):
        del notifications.os.environ["SLACK_DEPLOYMENTS_CHANNEL"]
        notifications.notify(self.args, lambda *args: self.fail("Must not send"))
        self.assertFalse(Path(self.args.state_file).exists())

    def test_slack_payload_uses_thread_ts_without_broadcast(self):
        with patch.object(notifications, "urlopen") as open_url:
            open_url.return_value.__enter__.return_value = io.StringIO(json.dumps({"ok": True, "channel": "CFIXTURE", "ts": "123.457"}))
            self.assertEqual(notifications.post("fixture-secret", "CFIXTURE", "Done", "123.456"), "123.457")
            body = json.loads(open_url.call_args.args[0].data)
            self.assertEqual(body["thread_ts"], "123.456")
            self.assertFalse(body["reply_broadcast"])

    def test_main_reports_failure_without_leaking_or_failing_the_deploy(self):
        argv = ["notify", "started"]
        for key, value in vars(self.args).items():
            if key != "status":
                argv.extend([f"--{key.replace('_', '-')}", value])
        with patch("sys.argv", argv), patch("sys.stdout", new_callable=io.StringIO) as stdout, \
             patch.object(notifications, "notify", side_effect=RuntimeError("fixture-secret")):
            notifications.main()
            self.assertIn("deployment_notification_failed", stdout.getvalue())
            self.assertNotIn("fixture-secret", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
