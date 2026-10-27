#!/usr/bin/env python3
"""Real restic/PostgreSQL/Redis recovery proof; run only in the disposable test network."""

import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


def run(*command, input=None, env=None, ok=True):
    result = subprocess.run(
        command,
        input=input,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )
    if ok and result.returncode:
        raise AssertionError(
            f"Test command {command[0]} failed: {result.stderr.decode()}"
        )
    return result


class RestoreTest(unittest.TestCase):
    def test_recovery_and_failure_receipts(self):
        os.umask(0o077)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            password = root / "password"
            password.write_text("synthetic-test-only-recovery-secret")
            env = {
                **os.environ,
                "RESTIC_REPOSITORY": str(root / "repository"),
                "RESTIC_PASSWORD_FILE": str(password),
                "PGPASSWORD": "synthetic-test-only",
            }
            run("restic", "init", env=env)
            run(
                "psql",
                "-h",
                "db",
                "-U",
                "postgres",
                "-c",
                "CREATE DATABASE backup_test",
                env=env,
            )
            run(
                "psql",
                "-h",
                "db",
                "-U",
                "postgres",
                "-d",
                "backup_test",
                env=env,
                input=b"CREATE TABLE recovery_probe (id int primary key, value text); INSERT INTO recovery_probe VALUES (1, 'synthetic-order-781');",
            )
            run(
                "redis-cli",
                "-h",
                "cache",
                "SET",
                "recovery-probe",
                "synthetic-queued-job-782",
            )
            files = root / "files"
            files.mkdir()
            (files / "settings.json").write_text('{"synthetic":"file-recovery-783"}')
            pg = [
                "pg_dump",
                "-h",
                "db",
                "-U",
                "postgres",
                "--format=custom",
                "backup_test",
            ]
            config = {
                "name": "datool-test",
                "state_directory": str(root / "state"),
                "paths": [str(files)],
                "streams": [
                    {"filename": "postgres.dump", "command": pg},
                    {
                        "filename": "redis.rdb",
                        "command": ["redis-cli", "-h", "cache", "--rdb", "-"],
                    },
                    {
                        "filename": "application.env",
                        "command": ["printf", "SYNTHETIC_KEY=secret-recovery-784\n"],
                    },
                ],
            }
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config))
            runner = [
                "python3",
                str(Path(__file__).with_name("backup.py")),
                str(config_path),
            ]
            output = run(*runner, env=env)
            self.assertNotIn(b"secret-recovery", output.stdout + output.stderr)
            success_path = root / "state" / "last-success.json"
            receipt = json.loads(success_path.read_text())
            self.assertEqual(receipt["status"], "complete")
            manifest = json.loads(
                run(
                    "restic",
                    "dump",
                    receipt["manifest_snapshot"],
                    "/manifest.json",
                    env=env,
                ).stdout
            )
            self.assertEqual(manifest["snapshots"], receipt["snapshots"])
            snapshots = receipt["snapshots"]

            run(
                "psql",
                "-h",
                "db",
                "-U",
                "postgres",
                "-c",
                "CREATE DATABASE recovered",
                env=env,
            )
            dump = run(
                "restic", "dump", snapshots["postgres.dump"], "/postgres.dump", env=env
            ).stdout
            run(
                "pg_restore",
                "-h",
                "db",
                "-U",
                "postgres",
                "-d",
                "recovered",
                "--exit-on-error",
                input=dump,
                env=env,
            )
            result = run(
                "psql",
                "-h",
                "db",
                "-U",
                "postgres",
                "-d",
                "recovered",
                "-Atc",
                "SELECT value FROM recovery_probe WHERE id=1",
                env=env,
            )
            self.assertEqual(result.stdout.strip(), b"synthetic-order-781")

            restored = root / "restored"
            restored.mkdir()
            (restored / "dump.rdb").write_bytes(
                run(
                    "restic", "dump", snapshots["redis.rdb"], "/redis.rdb", env=env
                ).stdout
            )
            run("redis-check-rdb", str(restored / "dump.rdb"))
            redis = subprocess.Popen(
                [
                    "redis-server",
                    "--port",
                    "6399",
                    "--bind",
                    "127.0.0.1",
                    "--dir",
                    str(restored),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while True:
                    probe = run("redis-cli", "-p", "6399", "PING", ok=False)
                    if probe.returncode == 0 and probe.stdout.strip() == b"PONG":
                        break
                    self.assertIsNone(
                        redis.poll(), "Restore Redis exited before becoming ready"
                    )
                    self.assertLess(
                        time.monotonic(), deadline, "Restore Redis did not become ready"
                    )
                    time.sleep(0.05)
                self.assertEqual(
                    run(
                        "redis-cli", "-p", "6399", "GET", "recovery-probe"
                    ).stdout.strip(),
                    b"synthetic-queued-job-782",
                )
            finally:
                redis.terminate()
                redis.wait(timeout=10)
            self.assertEqual(
                run(
                    "restic",
                    "dump",
                    snapshots["application.env"],
                    "/application.env",
                    env=env,
                ).stdout,
                b"SYNTHETIC_KEY=secret-recovery-784\n",
            )
            run(
                "restic",
                "restore",
                snapshots["files"],
                "--target",
                str(restored),
                "--verify",
                env=env,
            )
            self.assertEqual(
                (restored / str(files).lstrip("/") / "settings.json").read_text(),
                '{"synthetic":"file-recovery-783"}',
            )
            run("restic", "check", "--read-data", env=env)
            run(*runner, "--health", env=env)

            wrong = root / "wrong-password"
            wrong.write_text("wrong-synthetic-secret")
            self.assertNotEqual(
                run(
                    "restic",
                    "snapshots",
                    env={**env, "RESTIC_PASSWORD_FILE": str(wrong)},
                    ok=False,
                ).returncode,
                0,
            )
            for path in (root / "repository").rglob("*"):
                if path.is_file():
                    self.assertNotIn(b"secret-recovery-784", path.read_bytes())

            previous = success_path.read_bytes()
            before = json.loads(run("restic", "snapshots", "--json", env=env).stdout)
            config["streams"][0]["command"][-1] = "database_does_not_exist"
            config_path.write_text(json.dumps(config))
            failure = run(*runner, env=env, ok=False)
            self.assertNotEqual(failure.returncode, 0)
            self.assertEqual(success_path.read_bytes(), previous)
            self.assertEqual(
                json.loads(run("restic", "snapshots", "--json", env=env).stdout), before
            )
            self.assertNotEqual(
                run(*runner, "--health", env=env, ok=False).returncode, 0
            )
            self.assertNotIn(b"database_does_not_exist", failure.stderr)

            # A still-fresh older backup must not hide a failed preflight either.
            config["streams"][0]["command"][-1] = "backup_test"
            config["paths"] = [str(root / "missing")]
            config_path.write_text(json.dumps(config))
            self.assertNotEqual(run(*runner, env=env, ok=False).returncode, 0)
            self.assertNotEqual(
                run(*runner, "--health", env=env, ok=False).returncode, 0
            )
            self.assertEqual(success_path.read_bytes(), previous)

            old = json.loads(previous)
            # An active scheduled attempt does not make a fresh recovery set stale.
            running = {
                **old,
                "status": "running",
                "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
            (root / "state" / "last-attempt.json").write_text(json.dumps(running))
            run(*runner, "--health", env=env)
            running["started_at"] = (
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)
            ).isoformat()
            (root / "state" / "last-attempt.json").write_text(json.dumps(running))
            self.assertNotEqual(
                run(*runner, "--health", env=env, ok=False).returncode, 0
            )
            old["finished_at"] = (
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=31)
            ).isoformat()
            success_path.write_text(json.dumps(old))
            (root / "state" / "last-attempt.json").write_text(json.dumps(old))
            self.assertNotEqual(
                run(*runner, "--health", env=env, ok=False).returncode, 0
            )


if __name__ == "__main__":
    unittest.main()
