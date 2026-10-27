#!/usr/bin/env python3
"""Small restic runner: encrypted streams, complete-run receipt, no plaintext dumps."""

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


class BackupError(Exception):
    pass


def private(path, directory=False):
    path = Path(path)
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise BackupError(
            "Configuration, password and state must be owner-only, owned by the runner"
        )
    return path


def save(path, value):
    temporary = path.with_suffix(".tmp")
    with open(
        temporary, "w", opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW, 0o600)
    ) as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(path)


def restic(arguments, payload=None):
    result = subprocess.run(
        ["restic", "--no-cache", "--json", *arguments],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    # Never copy exporter stderr, filenames, repository URLs or secrets to logs.
    if result.returncode:
        raise BackupError(f"restic/export command failed (exit {result.returncode})")
    return result.stdout


def snapshot(base, arguments, payload=None):
    output = restic(["backup", *base, *arguments], payload)
    for line in output.splitlines():
        row = json.loads(line)
        if row.get("message_type") == "summary" and row.get("snapshot_id"):
            return row["snapshot_id"]
    raise BackupError("No successful snapshot receipt returned")


def validate_sources(config):
    if not os.environ.get("RESTIC_REPOSITORY"):
        raise BackupError(
            "RESTIC_REPOSITORY is required; initialize the repository separately"
        )
    private(os.environ["RESTIC_PASSWORD_FILE"])
    paths, streams = config["paths"], config["streams"]
    if not paths or not streams:
        raise BackupError("Both file paths and database streams are required")
    for path in paths:
        source = Path(path)
        if not source.is_absolute() or not source.exists() or source.is_symlink():
            raise BackupError(
                "Each backup source must exist at an absolute, non-symlink path"
            )
    names = set()
    for stream in streams:
        filename, command = stream["filename"], stream["command"]
        if (
            not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", filename)
            or filename in names
            or filename in {"manifest.json", "files", "complete"}
        ):
            raise BackupError("Stream filenames must be unique and safe")
        if not command or not all(isinstance(arg, str) and arg for arg in command):
            raise BackupError("Export command must be a nonempty argument array")
        names.add(filename)
    return paths, streams


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config")
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise BackupError("Run as root using the reviewed private configuration")
    config = json.loads(private(args.config).read_text())
    name = config["name"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        raise BackupError("Invalid backup name")
    state = Path(config["state_directory"])
    if not state.is_absolute():
        raise BackupError("State directory must be absolute")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    private(state, directory=True)
    if args.health:
        attempt = json.loads((state / "last-attempt.json").read_text())
        success = json.loads((state / "last-success.json").read_text())
        age = (
            dt.datetime.now(dt.timezone.utc)
            - dt.datetime.fromisoformat(success["finished_at"])
        ).total_seconds()
        if (
            attempt["status"] not in ["complete", "running"]
            or not 0 <= age <= config.get("max_age_hours", 30) * 3600
        ):
            raise BackupError("Backup failed or is stale")
        if attempt["status"] == "running":
            elapsed = (
                dt.datetime.now(dt.timezone.utc)
                - dt.datetime.fromisoformat(attempt["started_at"])
            ).total_seconds()
            if not 0 <= elapsed <= 7200:
                raise BackupError("Backup exceeded its two-hour runtime deadline")
        print(
            json.dumps(
                {
                    "event": "datool_backup_health",
                    "status": "running" if attempt["status"] == "running" else "fresh",
                    "run": success["run"],
                }
            )
        )
        return
    with open(
        state / "lock",
        "w",
        opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW, 0o600),
    ) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("Another backup is running") from None
        run = str(uuid.uuid4())
        receipt = {
            "run": run,
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "status": "running",
            "snapshots": {},
        }
        save(state / "last-attempt.json", receipt)
        base = [
            "--host",
            name,
            "--tag",
            name,
            "--tag",
            f"run:{run}",
            "--limit-upload",
            str(config.get("upload_kib_per_second", 4096)),
        ]
        try:
            paths, streams = validate_sources(config)
            for stream in streams:
                filename = stream["filename"]
                receipt["snapshots"][filename] = snapshot(
                    base,
                    [
                        "--tag",
                        filename,
                        "--stdin-filename",
                        filename,
                        "--stdin-from-command",
                        "--",
                        *stream["command"],
                    ],
                )
            receipt["snapshots"]["files"] = snapshot(
                base, ["--tag", "files", "--", *paths]
            )
            restic(["check"])
            receipt["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            receipt["status"] = "complete"
            # Only this internally generated, bounded receipt uses stdin. Database
            # exporters use --stdin-from-command so a failed exporter saves no snapshot.
            receipt["manifest_snapshot"] = snapshot(
                base,
                [
                    "--tag",
                    "complete",
                    "--stdin-filename",
                    "manifest.json",
                    "--stdin",
                ],
                json.dumps(receipt).encode(),
            )
            save(state / "last-success.json", receipt)
            save(state / "last-attempt.json", receipt)
            print(
                json.dumps({"event": "datool_backup", "status": "complete", "run": run})
            )
        except Exception:
            receipt["status"] = "failed"
            save(state / "last-attempt.json", receipt)
            raise


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        detail = (
            str(error)
            if isinstance(error, BackupError)
            else "Configuration or backup failed; inspect privately"
        )
        print(
            json.dumps(
                {
                    "event": "datool_backup",
                    "status": "failed",
                    "kind": type(error).__name__,
                    "detail": detail,
                }
            ),
            file=sys.stderr,
        )
        sys.exit(1)
