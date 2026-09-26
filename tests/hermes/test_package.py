"""Exercise the distributable ZIP and installer without provider credentials."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("hermes_packager", ROOT / "scripts/package-hermes-plugin.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.source = self.directory / "source"
        shutil.copytree(ROOT / "integrations/hermes", self.source)
        self.version = packager.plugin_version(self.source)

    def test_archive_allowlist_checksum_and_reproducible_bytes(self):
        (self.source / ".env").write_text("PRIVATE_CREDENTIAL=do-not-ship")
        (self.source / "outbox.sqlite3").write_text("private traces")
        first, checksum = packager.build_bundle(self.source, self.directory / "first")
        self.assertEqual(first.name, f"datool-hermes-{self.version}.zip")
        self.assertEqual(checksum.read_text(), f"{hashlib.sha256(first.read_bytes()).hexdigest()}  {first.name}\n")
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.namelist(), [f"datool-hermes/{name}" for name in packager.FILES])
            for name in packager.FILES:
                self.assertEqual(archive.read(f"datool-hermes/{name}"), (self.source / name).read_bytes())
                os.utime(self.source / name, (1_700_000_000, 1_700_000_000))
        second, _ = packager.build_bundle(self.source, self.directory / "second")
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_version_changes_filename_and_mismatched_tags_fail_before_writing(self):
        manifest = self.source / "plugin.yaml"
        manifest.write_text(manifest.read_text().replace(f'version: "{self.version}"', 'version: "1.2.3"'))
        output = self.directory / "release"
        for tag in ("hermes-v1.2.4", "v1.2.3", "hermes-v1.2.3-rc.1"):
            with self.assertRaisesRegex(ValueError, "Release tag must match"):
                packager.build_bundle(self.source, output, tag=tag)
            self.assertFalse(output.exists())
        bundle, _ = packager.build_bundle(self.source, output, tag="hermes-v1.2.3")
        self.assertEqual(bundle.name, "datool-hermes-1.2.3.zip")
        manifest.write_text('version: "../invalid"\n')
        with self.assertRaisesRegex(ValueError, "stable x.y.z"):
            packager.build_bundle(self.source, output)

    def test_rejects_symlinked_source_files(self):
        path = self.source / "README.md"
        path.unlink()
        path.symlink_to(ROOT / "integrations/hermes/README.md")
        with self.assertRaisesRegex(ValueError, "regular plugin source"):
            packager.build_bundle(self.source, self.directory / "release")

    def test_packager_cli_works_outside_the_repository(self):
        output = self.directory / "custom.zip"
        result = subprocess.run([sys.executable, str(ROOT / "scripts/package-hermes-plugin.py"),
                                 "--tag", f"hermes-v{self.version}", "--output", str(output)],
                                cwd=self.directory, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output.is_file())
        self.assertTrue(output.with_suffix(".zip.sha256").is_file())

    def test_extracted_installer_authenticates_and_enables_in_an_isolated_profile(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization"), self.headers.get("x-project-id")))
                # The installer authenticates by looking up a deliberately missing receipt.
                self.send_response(404)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            bundle, _ = packager.build_bundle(self.source, self.directory / "release")
            extracted = self.directory / "extracted"
            with zipfile.ZipFile(bundle) as archive:
                archive.extractall(extracted)
            profile = self.directory / "profile"
            # Exercise the real installer subprocess boundary; only Hermes enable is a stub.
            hermes = self.directory / "hermes"
            hermes.write_text(f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n"
                              "Path(os.environ['HERMES_HOME'], 'enable-args.json').write_text(json.dumps(sys.argv[1:]))\n")
            hermes.chmod(0o755)
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("DATOOL_", "HERMES_", "OPENAI_"))}
            env.update(DATOOL_BASE_URL=f"http://127.0.0.1:{server.server_port}",
                       DATOOL_PROJECT_ID="release-test", DATOOL_API_KEY="release-test-secret")
            result = subprocess.run([sys.executable, str(extracted / "datool-hermes/install.py"),
                                     "--home", str(profile), "--hermes", str(hermes)],
                                    cwd=self.directory, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(seen), 1)
            self.assertTrue(seen[0][0].startswith("/api/ingest?eventId="))
            self.assertEqual(seen[0][1:], ("Bearer release-test-secret", "release-test"))
            self.assertEqual(json.loads((profile / "enable-args.json").read_text()),
                             ["plugins", "enable", "datool", "--no-allow-tool-override"])
            for name in ("__init__.py", "plugin.yaml"):
                self.assertEqual((profile / "plugins/datool" / name).read_bytes(), (self.source / name).read_bytes())
            config = profile / "datool/config.json"
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(config.read_text())["project_id"], "release-test")
            self.assertNotIn("release-test-secret", result.stdout + result.stderr)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
