#!/usr/bin/env python3
"""Expose only Datool container log paths, without exposing Docker's socket to Fluent Bit."""
import json
import os
from pathlib import Path
import re
import subprocess

DESTINATION = Path("/var/log/datool-logging/containers")
ALLOWED_NAME = re.compile(r"(?:datool\.(?:web|worker)\.\d+|dokku\.(?:postgres\.datool-db|redis\.datool-redis))\Z")


def selected_logs(records):
    selected = {}
    for record in records:
        name = record["Name"].removeprefix("/")
        container_id = record["Id"]
        if not ALLOWED_NAME.fullmatch(name) or not re.fullmatch(r"[0-9a-f]{64}", container_id):
            continue
        path = Path(record["LogPath"])
        expected = Path("/var/lib/docker/containers") / container_id / f"{container_id}-json.log"
        if path != expected:
            raise RuntimeError(f"Unsupported log path or driver for {name}")
        selected[f"{name}.{container_id}.log"] = path
    return selected


def main():
    ids = subprocess.check_output(["docker", "ps", "--no-trunc", "--format", "{{.ID}}"], text=True).split()
    # Only request these fields. Never read/export a container's environment.
    records = []
    if ids:
        lines = subprocess.check_output([
            "docker", "inspect", "--format",
            '{"Name":{{json .Name}},"Id":{{json .Id}},"LogPath":{{json .LogPath}}}', *ids
        ], text=True).splitlines()
        records = [json.loads(line) for line in lines]
    selected = selected_logs(records)
    DESTINATION.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, target in selected.items():
        link = DESTINATION / name
        if link.is_symlink() and Path(os.readlink(link)) == target:
            continue
        if link.exists() or link.is_symlink():
            raise RuntimeError(f"Refusing to replace unexpected path {link}")
        link.symlink_to(target)
    # Preserve stopped-container links while their files exist so Fluent Bit
    # can drain the final records of a rolling deployment.
    for link in DESTINATION.glob("*.log"):
        if link.is_symlink() and not link.exists():
            link.unlink()
    print(f"Discovered {len(selected)} running Datool log sources")


if __name__ == "__main__":
    main()
