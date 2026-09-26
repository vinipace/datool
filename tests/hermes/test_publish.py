"""Exercise release guards with real Git repositories and an isolated GitHub fixture."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.repo = self.directory / "checkout"
        self.repo.mkdir()
        self.remote = self.directory / "origin.git"
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME="Release fixture", GIT_COMMITTER_NAME="Release fixture",
                        GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_EMAIL="fixture@example.invalid")
        # Never inherit credentials or alternate Git directories from the caller.
        for key in list(self.env):
            if key.startswith(("GH_", "GITHUB_", "CIRCLE_")) or key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
                self.env.pop(key)
        self.git("init", "--bare", str(self.remote))
        self.git("init", "-b", "main")
        self.git("remote", "add", "origin", str(self.remote))
        shutil.copytree(ROOT / "integrations/hermes", self.repo / "integrations/hermes")
        (self.repo / "scripts").mkdir()
        for name in ("package-hermes-plugin.py", "publish-hermes-plugin.sh"):
            shutil.copyfile(ROOT / "scripts" / name, self.repo / "scripts" / name)
        self.git("add", ".")
        self.git("commit", "-m", "Release fixture")
        self.git("push", "origin", "main")
        self.sha = self.git("rev-parse", "HEAD").strip()
        subprocess.run([sys.executable, "scripts/package-hermes-plugin.py", "--output-dir", "dist/hermes"],
                       cwd=self.repo, env=self.env, check=True, capture_output=True)
        self.bundle = next((self.repo / "dist/hermes").glob("*.zip"))
        self.version = self.bundle.name.removeprefix("datool-hermes-").removesuffix(".zip")
        self.tag = f"hermes-v{self.version}"
        (self.repo / "dist/hermes/commit.txt").write_text(self.sha + "\n")
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        (self.bin / "python3").symlink_to(sys.executable)
        if not shutil.which("sha256sum"):
            checksum = self.bin / "sha256sum"
            checksum.write_text("#!/bin/sh\nexec shasum -a 256 \"$@\"\n")
            checksum.chmod(0o755)
        self.calls = self.directory / "calls.jsonl"
        gh = self.bin / "gh"
        gh.write_text(f"#!{sys.executable}\n" + '''import json, os, pathlib, shutil, subprocess, sys
args = sys.argv[1:]
with open(os.environ["FIXTURE_CALLS"], "a") as stream:
    stream.write(json.dumps(args) + "\\n")
if args[0] == "api":
    fields = dict(value.split("=", 1) for value in args if value.startswith(("ref=", "sha=")))
    subprocess.run(["git", "--git-dir", os.environ["FIXTURE_REMOTE"], "update-ref", fields["ref"], fields["sha"]], check=True)
elif args[:2] == ["release", "create"]:
    if os.environ.get("FIXTURE_EXISTING_RELEASE"):
        sys.exit("release already exists")
    destination = pathlib.Path(os.environ["FIXTURE_ASSETS"])
    destination.mkdir()
    for value in args[3:5]:
        shutil.copyfile(value, destination / pathlib.Path(value).name)
elif args[:2] == ["release", "download"]:
    destination = pathlib.Path(args[args.index("--dir") + 1])
    shutil.copytree(os.environ["FIXTURE_ASSETS"], destination)
    if os.environ.get("FIXTURE_CORRUPT_DOWNLOAD"):
        next(destination.glob("*.zip")).write_bytes(b"corrupted download")
elif args[:2] != ["release", "edit"]:
    sys.exit("unexpected GitHub command")
''')
        gh.chmod(0o755)
        self.env.update(PATH=f"{self.bin}{os.pathsep}{self.env['PATH']}", CIRCLE_BRANCH="main",
                        CIRCLE_SHA1=self.sha, CIRCLE_PROJECT_USERNAME="fixture-owner",
                        CIRCLE_PROJECT_REPONAME="fixture-repo", RELEASE_VERSION=self.version,
                        GH_TOKEN="fixture-not-a-credential", FIXTURE_REMOTE=str(self.remote),
                        FIXTURE_CALLS=str(self.calls), FIXTURE_ASSETS=str(self.directory / "uploaded"))

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              check=True, text=True, capture_output=True).stdout

    def publish(self, **overrides):
        return subprocess.run(["bash", "scripts/publish-hermes-plugin.sh"], cwd=self.repo,
                              env=dict(self.env, **overrides), capture_output=True, text=True)

    def recorded_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_release_uploads_original_assets_and_verifies_before_publishing(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded_calls()
        self.assertEqual([call[:2] for call in calls], [
            ["api", "repos/fixture-owner/fixture-repo/git/refs"], ["release", "create"],
            ["release", "download"], ["release", "edit"], ["release", "download"]])
        self.assertIn("--draft", calls[1])
        self.assertIn("--verify-tag", calls[1])
        self.assertIn("--latest=false", calls[1])
        self.assertIn("--latest=false", calls[3])
        self.assertEqual((self.directory / "uploaded" / self.bundle.name).read_bytes(), self.bundle.read_bytes())
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", f"refs/tags/{self.tag}").strip(), self.sha)
        self.assertNotIn(self.env["GH_TOKEN"], result.stdout + result.stderr)

    def test_branch_tag_version_and_commit_guards_precede_github_access(self):
        for overrides in ({"CIRCLE_BRANCH": "feature"}, {"CIRCLE_TAG": self.tag},
                          {"RELEASE_VERSION": ""}, {"RELEASE_VERSION": "1.2.3-rc.1"},
                          {"RELEASE_VERSION": "999.0.0"}, {"CIRCLE_SHA1": "0" * 40}, {"GH_TOKEN": ""}):
            with self.subTest(overrides=overrides):
                result = self.publish(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.recorded_calls(), [])

    def test_tampered_bundle_or_stale_artifacts_never_reach_github(self):
        original = self.bundle.read_bytes()
        self.bundle.write_bytes(b"unverified bundle")
        self.assertNotEqual(self.publish().returncode, 0)
        self.assertEqual(self.recorded_calls(), [])
        self.bundle.write_bytes(original)
        (self.repo / "dist/hermes/commit.txt").write_text("0" * 40)
        self.assertNotEqual(self.publish().returncode, 0)
        self.assertEqual(self.recorded_calls(), [])

    def test_commit_outside_main_never_reaches_github(self):
        self.git("commit", "--allow-empty", "-m", "Not pushed to main")
        sha = self.git("rev-parse", "HEAD").strip()
        (self.repo / "dist/hermes/commit.txt").write_text(sha)
        self.assertNotEqual(self.publish(CIRCLE_SHA1=sha).returncode, 0)
        self.assertEqual(self.recorded_calls(), [])

    def test_annotated_matching_tag_is_reused_and_wrong_target_is_rejected(self):
        self.git("tag", "-a", self.tag, "-m", "Existing tag")
        self.git("push", "origin", self.tag)
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "api" for call in self.recorded_calls()))
        self.calls.unlink()
        self.git("commit", "--allow-empty", "-m", "Other target")
        self.git("--git-dir", str(self.remote), "fetch", str(self.repo), "HEAD")
        self.git("--git-dir", str(self.remote), "update-ref", f"refs/tags/{self.tag}", "FETCH_HEAD")
        self.git("checkout", self.sha)
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.recorded_calls(), [])

    def test_corrupt_download_leaves_release_as_draft(self):
        result = self.publish(FIXTURE_CORRUPT_DOWNLOAD="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[:2] == ["release", "edit"] for call in self.recorded_calls()))

    def test_existing_release_is_not_edited_or_overwritten(self):
        result = self.publish(FIXTURE_EXISTING_RELEASE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[:2] in (["release", "edit"], ["release", "download"])
                             for call in self.recorded_calls()))


if __name__ == "__main__":
    unittest.main()
