"""Validate release artifacts and verify their published PyPI digests. Never uploads."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from email import message_from_bytes
from pathlib import Path
from typing import Any


def distributions(directory: Path, expected_version: str = "") -> tuple[str, dict[str, str]]:
    files = {p.name: p for p in directory.iterdir() if p.name != ".gitignore"}
    wheels = [name for name in files if name.endswith(".whl")]
    if len(wheels) != 1:
        raise ValueError("Expected exactly one Datool wheel")
    match = re.fullmatch(r"datool-(\d+\.\d+\.\d+)-py3-none-any\.whl", wheels[0])
    if not match:
        raise ValueError("Expected a stable datool X.Y.Z universal Python wheel")
    version = match[1]
    if expected_version and version != expected_version:
        raise ValueError(f"Built version {version} does not match requested {expected_version}")
    archive = f"datool-{version}.tar.gz"
    if set(files) != {wheels[0], archive}:
        raise ValueError("Distribution directory must contain only the matching wheel and sdist")
    with zipfile.ZipFile(files[wheels[0]]) as wheel:
        wheel_metadata = wheel.read(f"datool-{version}.dist-info/METADATA")
    with tarfile.open(files[archive]) as source:
        member = source.extractfile(f"datool-{version}/PKG-INFO")
        if member is None:
            raise ValueError("Source archive is missing its package metadata")
        source_metadata = member.read()
    for raw in (wheel_metadata, source_metadata):
        metadata = message_from_bytes(raw)
        if metadata["Name"] != "datool" or metadata["Version"] != version:
            raise ValueError("Distribution metadata does not match datool and the release version")
    return version, {
        name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()
    }


def registry_matches(payload: dict[str, Any], version: str, hashes: dict[str, str]) -> bool:
    if payload["info"]["name"] != "datool" or payload["info"]["version"] != version:
        raise ValueError("PyPI returned a different package or version")
    published = {item["filename"]: item["digests"]["sha256"] for item in payload["urls"]}
    for name, digest in hashes.items():
        if name in published and published[name] != digest:
            raise ValueError(f"PyPI digest differs from the tested artifact: {name}")
    return hashes.items() <= published.items()


def verify_registry(version: str, hashes: dict[str, str]) -> None:
    # Allow bounded index propagation after upload; immutable digest mismatches
    # fail immediately instead of passing after a retry or publishing again.
    for attempt in range(12):
        try:
            with urllib.request.urlopen(
                f"https://pypi.org/pypi/datool/{version}/json", timeout=15
            ) as r:
                payload = json.load(r)
            if registry_matches(payload, version, hashes):
                return
        except urllib.error.HTTPError as exc:
            if exc.code != 404 and exc.code != 429 and exc.code < 500:
                raise
        except urllib.error.URLError:
            pass
        if attempt < 11:
            time.sleep(5)
    raise RuntimeError(f"PyPI did not expose both datool {version} release files in time")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "verify"])
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--version", default="")
    args = parser.parse_args()
    version, hashes = distributions(args.dist, args.version)
    if args.command == "verify":
        verify_registry(version, hashes)
    print(json.dumps({"package": "datool", "version": version, "sha256": hashes}, indent=2))


if __name__ == "__main__":
    main()
