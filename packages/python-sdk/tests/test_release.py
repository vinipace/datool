import importlib.util
import io
import json
import tarfile
import urllib.error
import zipfile
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "datool_release", Path(__file__).resolve().parents[1] / "scripts" / "release.py"
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


@pytest.fixture
def artifacts(tmp_path):
    def build(wheel_name="datool", source_version="0.1.0"):
        with zipfile.ZipFile(tmp_path / "datool-0.1.0-py3-none-any.whl", "w") as wheel:
            wheel.writestr(
                "datool-0.1.0.dist-info/METADATA", f"Name: {wheel_name}\nVersion: 0.1.0\n"
            )
        with tarfile.open(tmp_path / "datool-0.1.0.tar.gz", "w:gz") as source:
            data = f"Name: datool\nVersion: {source_version}\n".encode()
            member = tarfile.TarInfo("datool-0.1.0/PKG-INFO")
            member.size = len(data)
            source.addfile(member, io.BytesIO(data))
        return tmp_path

    return build


def test_release_requires_the_exact_requested_version_and_matching_archives(artifacts):
    directory = artifacts()
    version, hashes = release.distributions(directory, "0.1.0")
    assert version == "0.1.0"
    assert set(hashes) == {"datool-0.1.0-py3-none-any.whl", "datool-0.1.0.tar.gz"}
    assert all(len(digest) == 64 for digest in hashes.values())
    with pytest.raises(ValueError, match="does not match requested"):
        release.distributions(directory, "0.2.0")
    (directory / "datool-0.1.0.tar.gz").unlink()
    with pytest.raises(ValueError, match="only the matching"):
        release.distributions(directory)


@pytest.mark.parametrize("extra", ["unrelated.whl", "old-release.tar.gz", "credentials.txt"])
def test_release_rejects_extra_distribution_files(artifacts, extra):
    directory = artifacts()
    (directory / extra).write_text("not part of the tested release")
    with pytest.raises(ValueError):
        release.distributions(directory)


@pytest.mark.parametrize("options", [{"wheel_name": "another-sdk"}, {"source_version": "0.2.0"}])
def test_release_checks_archive_metadata_not_just_filenames(artifacts, options):
    with pytest.raises(ValueError, match="metadata does not match"):
        release.distributions(artifacts(**options), "0.1.0")


def published(hashes):
    return {
        "info": {"name": "datool", "version": "0.1.0"},
        "urls": [
            {"filename": name, "digests": {"sha256": digest}} for name, digest in hashes.items()
        ],
    }


def test_published_release_must_match_both_tested_files(artifacts):
    version, hashes = release.distributions(artifacts())
    payload = published(hashes)
    assert release.registry_matches(payload, version, hashes)
    payload["urls"].pop()
    assert not release.registry_matches(payload, version, hashes)
    payload["urls"][0]["digests"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="digest differs"):
        release.registry_matches(payload, version, hashes)


def test_registry_propagation_is_retried_but_digest_mismatches_are_not(artifacts, monkeypatch):
    version, hashes = release.distributions(artifacts())
    payload = published(hashes)
    responses = [urllib.error.HTTPError("https://pypi.org", 404, "not yet", {}, None), payload]
    sleeps = []

    def request(url, timeout):
        assert url == "https://pypi.org/pypi/datool/0.1.0/json"
        assert timeout == 15
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(json.dumps(response).encode())

    monkeypatch.setattr(release.urllib.request, "urlopen", request)
    monkeypatch.setattr(release.time, "sleep", sleeps.append)
    release.verify_registry(version, hashes)
    assert sleeps == [5]
    payload["urls"][0]["digests"]["sha256"] = "0" * 64
    responses.append(payload)
    with pytest.raises(ValueError, match="digest differs"):
        release.verify_registry(version, hashes)
    assert sleeps == [5]


def test_registry_verification_stops_after_bounded_propagation_wait(monkeypatch):
    sleeps = []

    def missing(url, timeout):
        raise urllib.error.HTTPError(url, 404, "not found", {}, None)

    monkeypatch.setattr(release.urllib.request, "urlopen", missing)
    monkeypatch.setattr(release.time, "sleep", sleeps.append)
    with pytest.raises(RuntimeError, match="did not expose"):
        release.verify_registry("0.1.0", {"datool.whl": "digest"})
    assert len(sleeps) == 11
