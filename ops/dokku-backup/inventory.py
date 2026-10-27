#!/usr/bin/env python3
"""Read-only host/storage metadata. Never prints environment values or customer rows."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess


def command(arguments, timeout=20):
    try:
        result = subprocess.run(
            arguments, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except (subprocess.SubprocessError, OSError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--postgres", required=True, help="PostgreSQL container name")
    parser.add_argument("--redis", required=True, help="Redis container name")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit(
            "Run with sudo; this inspects metadata without printing keys or customer records."
        )
    report = {
        "readOnly": True,
        "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "cpuCount": os.cpu_count(),
        "resticInstalled": bool(shutil.which("restic")),
        "providerEncryption": "not established by guest inspection",
        "containers": [],
    }
    report["memory"] = {
        key: value.strip()
        for key, value in (
            line.split(":", 1)
            for line in Path("/proc/meminfo").read_text().splitlines()
        )
        if key in ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"]
    }
    report["rootFilesystem"] = command(["df", "-B1", "--output=size,used,avail", "/"])
    for name in [
        f"{args.app}.web.1",
        f"{args.app}.worker.1",
        args.postgres,
        args.redis,
    ]:
        raw = command(["docker", "inspect", name])
        if raw is None:
            report["containers"].append(
                {"container": name, "inspection": "unavailable"}
            )
            continue
        info = json.loads(raw)[0]
        env = dict(
            value.split("=", 1)
            for value in info["Config"].get("Env", [])
            if "=" in value
        )
        item = {
            "container": name,
            "image": info["Config"]["Image"],
            "running": info["State"]["Running"],
            "mounts": [],
            "publishedBeyondLoopback": any(
                binding.get("HostIp") not in ["127.0.0.1", "::1"]
                for bindings in info.get("NetworkSettings", {})
                .get("Ports", {})
                .values()
                for binding in (bindings or [])
            ),
        }
        image = command(["docker", "image", "inspect", info["Image"]])
        if image:
            item["revision"] = (json.loads(image)[0]["Config"].get("Labels") or {}).get(
                "org.opencontainers.image.revision"
            )
        for mount in info.get("Mounts", []):
            source = mount.get("Source")
            if not source:
                continue
            filesystem = command(["findmnt", "-J", "-T", source, "-o", "SOURCE,FSTYPE"])
            fs = json.loads(filesystem)["filesystems"][0] if filesystem else {}
            layers = (
                command(["lsblk", "-s", "-n", "-o", "TYPE", fs.get("source", "")]) or ""
            )
            size = command(["nice", "-n", "19", "du", "-sx", "-B1", source], timeout=60)
            item["mounts"].append(
                {
                    "destination": mount["Destination"],
                    "source": source,
                    "filesystem": fs.get("fstype"),
                    "guestEncryptionDetected": "crypt" in layers.split(),
                    "bytes": int(size.split()[0]) if size else None,
                }
            )
        if name == args.postgres:
            query = "SELECT json_build_object('databaseBytes',pg_database_size(current_database()),'tlsEnabled',current_setting('ssl'),'serverVersion',current_setting('server_version'))"
            metadata = command(
                [
                    "docker",
                    "exec",
                    "-e",
                    "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000",
                    name,
                    "psql",
                    "-U",
                    env.get("POSTGRES_USER", "postgres"),
                    "-d",
                    env.get("POSTGRES_DB") or env.get("POSTGRES_USER", "postgres"),
                    "-Atc",
                    query,
                ]
            )
            item["databaseMetadata"] = (
                json.loads(metadata) if metadata else "unavailable"
            )
        report["containers"].append(item)
    timers = (
        command(["systemctl", "list-timers", "--all", "--no-pager", "--no-legend"])
        or ""
    )
    report["backupTimers"] = [
        line.split()[-2:]
        for line in timers.splitlines()
        if any(word in line.lower() for word in ["backup", "restic", "borg"])
    ]
    report["backupCronFiles"] = [
        path.name
        for path in Path("/etc/cron.d").glob("*")
        if any(word in path.name.lower() for word in ["backup", "restic", "borg"])
    ]
    report["scheduleScanLimit"] = (
        "Does not inspect provider backups, user crontabs or prove successful recovery"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
