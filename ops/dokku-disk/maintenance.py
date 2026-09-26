#!/usr/bin/env python3
"""Bounded Datool image retention and serialized, capacity-checked imports."""

import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

STATE_DIR = Path("/var/lib/dokku/data/datool-disk-maintenance")
IMAGE = re.compile(r"datool-release:[0-9a-f]{40}-[0-9]+-[0-9]+")
GIB = 1024**3


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect(*refs):
    return json.loads(output("docker", "inspect", *refs)) if refs else []


def current_image():
    ref = output("dokku", "git:report", "datool", "--git-source-image")
    if not ref:
        # A never-deployed app has no source to protect. Missing metadata on an
        # existing installation is ambiguous and must still fail closed.
        deployed = output("dokku", "ps:report", "datool", "--deployed")
        containers = output("docker", "ps", "-aq", "--filter", "label=com.dokku.app-name=datool")
        images = output("docker", "image", "ls", "--filter", "reference=dokku/datool:*", "-q")
        if deployed == "false" and not read_history() and not containers and not images:
            return None
    if not IMAGE.fullmatch(ref):
        raise RuntimeError("Cannot identify Datool's current source image; refusing cleanup")
    inspect(ref)  # Fail closed if the rebuild source has disappeared.
    return ref


def read_history():
    path = STATE_DIR / "successful-images.json"
    if not path.exists():
        return []
    history = json.loads(path.read_text())
    if not isinstance(history, list) or any(
        not isinstance(ref, str) or not IMAGE.fullmatch(ref) for ref in history
    ):
        raise RuntimeError("Invalid image retention state; refusing cleanup")
    return history[:2]


def remember(ref):
    if not isinstance(ref, str) or not IMAGE.fullmatch(ref):
        raise ValueError("Only a validated Datool release can enter retention history")
    history = list(dict.fromkeys([ref, *read_history()]))[:2]
    temporary = STATE_DIR / "successful-images.json.tmp"
    temporary.write_text(json.dumps(history) + "\n")
    os.replace(temporary, STATE_DIR / "successful-images.json")


def removal_candidates(images, protected_refs, used_ids):
    return sorted({
        tag
        for image in images
        if image["Id"] not in used_ids
        for tag in image.get("RepoTags") or []
        if IMAGE.fullmatch(tag) and tag not in protected_refs
    })


def cleanup():
    current = current_image()
    if current is None:
        # Preserve any preloaded source archives until the first release has
        # succeeded; their provenance cannot yet be inferred from Dokku state.
        prune_cache()
        return
    protected = {current, *read_history()}
    container_ids = output("docker", "ps", "-aq").split()
    used_ids = {item["Image"] for item in inspect(*container_ids)}
    refs = output(
        "docker", "image", "ls", "--filter", "reference=datool-release:*",
        "--format", "{{.Repository}}:{{.Tag}}",
    ).split()
    images = inspect(*refs)
    # Preserve every alias of protected source images, as well as every image
    # referenced by a running OR stopped container. Never force-remove images.
    used_ids.update(
        image["Id"] for image in images
        if protected.intersection(image.get("RepoTags") or [])
    )
    for tag in removal_candidates(images, protected, used_ids):
        print(f"Removing obsolete Datool source image: {tag}", flush=True)
        subprocess.run(["docker", "image", "rm", tag], check=True)
    prune_cache()


def prune_cache():
    # Dokku's image-label builds retain layers even after their source tag is
    # removed. Evict unused cache now: an age filter lets rapid deploys fill the
    # disk before the daily job can reclaim it. Docker keeps live image layers
    # and cache currently used by builds; this never prunes images or volumes.
    subprocess.run([
        "docker", "buildx", "prune", "--all", "--force",
        "--reserved-space", "512MB", "--max-used-space", "512MB",
    ], check=True)


def required_space(image_bytes):
    # containerd keeps content blobs and unpacked snapshots concurrently.
    return max(6 * GIB, 2 * image_bytes + 2 * GIB)


def check_space(image_bytes):
    required = required_space(image_bytes)
    for path in {Path("/var/lib/containerd"), Path(output(
        "docker", "info", "--format", "{{.DockerRootDir}}"
    ))}:
        available = shutil.disk_usage(path).free
        print(f"{path}: {available / GIB:.1f} GiB available; "
              f"{required / GIB:.1f} GiB required", flush=True)
        if available < required:
            raise RuntimeError("Insufficient deployment headroom; image import was not started")


def load_image(ref, size):
    if not IMAGE.fullmatch(ref) or not size.isdecimal() or not 0 < int(size) <= 20 * GIB:
        raise ValueError("Expected a Datool release tag and image size in bytes (1..20 GiB)")
    # This lock also covers cleanup and the complete Dokku release. A periodic
    # cleanup cannot delete an image between import and container creation.
    current = current_image()
    if current is not None:
        remember(current)
    cleanup()
    check_space(int(size))
    # Dokku otherwise rejects retrying the same image as an unchanged Git
    # context. A unique context marker requests a real release on every retry;
    # its generated Dockerfile still uses only the verified image as its base.
    with tempfile.TemporaryDirectory(prefix="datool-image-import-") as directory:
        (Path(directory) / "datool-deployment-id").write_text(str(uuid.uuid4()) + "\n")
        subprocess.run([
            "dokku", "git:load-image", "datool", ref, "--build-dir", directory,
        ], check=True)
    if current_image() != ref:
        raise RuntimeError("Dokku did not record the requested release")
    remember(ref)
    cleanup()


def report():
    print(json.dumps({
        "current_image": current_image(),
        "retained_successful_images": read_history(),
        "free_gib": round(shutil.disk_usage("/var/lib/containerd").free / GIB, 2),
    }, indent=2))


def check_minimum():
    if shutil.disk_usage("/var/lib/containerd").free < 6 * GIB:
        raise RuntimeError("Less than 6 GiB free; capacity attention required")


def main(argv):
    if len(argv) < 2 or argv[1] != "datool":
        raise ValueError("Only the datool app is supported")
    action = argv[0].removeprefix("disk:")
    with (STATE_DIR / "maintenance.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == "load-image" and len(argv) == 4:
            load_image(argv[2], argv[3])
        elif action == "cleanup" and len(argv) == 2:
            if not read_history():
                current = current_image()
                if current is not None:
                    remember(current)
            cleanup()
            report()
            check_minimum()
        elif action == "status" and len(argv) == 2:
            report()
            check_minimum()
        else:
            raise ValueError("Expected disk:load-image, disk:cleanup, or disk:status")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Datool disk maintenance failed: {error}", file=sys.stderr)
        sys.exit(1)
