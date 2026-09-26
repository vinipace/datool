import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

spec = importlib.util.spec_from_file_location(
    "maintenance", Path(__file__).parents[1] / "ops/dokku-disk/maintenance.py"
)
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


def ref(letter):
    return f"datool-release:{letter * 40}-123-1"


class DiskMaintenanceTest(unittest.TestCase):
    def test_bootstrap_requires_no_deployment_history_containers_or_images(self):
        for deployed, containers, images, history, allowed in [
            ("false", "", "", [], True),
            ("true", "", "", [], False),
            ("", "", "", [], False),
            ("false", "container", "", [], False),
            ("false", "", "image", [], False),
            ("false", "", "", [ref("a")], False),
        ]:
            with self.subTest(deployed=deployed, containers=containers, images=images, history=history), \
                 patch.object(disk, "output", side_effect=["", deployed, containers, images]), \
                 patch.object(disk, "read_history", return_value=history):
                if allowed:
                    self.assertIsNone(disk.current_image())
                else:
                    with self.assertRaisesRegex(RuntimeError, "refusing cleanup"):
                        disk.current_image()

    def test_pristine_cleanup_does_not_delete_preloaded_source_images(self):
        with patch.object(disk, "current_image", return_value=None), \
             patch.object(disk.subprocess, "run") as run:
            disk.cleanup()
            self.assertEqual(run.call_args_list, [call([
                "docker", "buildx", "prune", "--all", "--force",
                "--reserved-space", "512MB", "--max-used-space", "512MB",
            ], check=True)])

    def test_first_import_checks_capacity_then_records_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(disk, "STATE_DIR", Path(directory)), \
             patch.object(disk, "current_image", side_effect=[None, ref("a")]), \
             patch.object(disk, "cleanup") as cleanup, \
             patch.object(disk, "check_space") as capacity, \
             patch.object(disk.subprocess, "run") as run:
            events = []
            capacity.side_effect = lambda size: events.append("capacity")
            run.side_effect = lambda *args, **kwargs: events.append("import")
            disk.load_image(ref("a"), str(disk.GIB))
            self.assertEqual(events, ["capacity", "import"])
            self.assertEqual(disk.read_history(), [ref("a")])
            self.assertEqual(cleanup.call_count, 2)

    def test_failed_first_import_leaves_no_success_history(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(disk, "STATE_DIR", Path(directory)), \
             patch.object(disk, "current_image", return_value=None), \
             patch.object(disk, "cleanup"), patch.object(disk, "check_space"), \
             patch.object(disk.subprocess, "run", side_effect=disk.subprocess.CalledProcessError(1, "dokku")):
            with self.assertRaises(disk.subprocess.CalledProcessError):
                disk.load_image(ref("a"), str(disk.GIB))
            self.assertEqual(disk.read_history(), [])

    def test_same_image_retry_requests_a_distinct_release_context(self):
        markers = []
        directories = []

        def import_image(command, **kwargs):
            self.assertEqual(command[:5], ["dokku", "git:load-image", "datool", ref("a"), "--build-dir"])
            directory = Path(command[5])
            directories.append(directory)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ["datool-deployment-id"])
            markers.append((directory / "datool-deployment-id").read_text())

        with patch.object(disk, "current_image", return_value=ref("a")), \
             patch.object(disk, "remember"), patch.object(disk, "cleanup"), \
             patch.object(disk, "check_space"), \
             patch.object(disk.subprocess, "run", side_effect=import_image):
            disk.load_image(ref("a"), str(disk.GIB))
            disk.load_image(ref("a"), str(disk.GIB))
        self.assertEqual(len(set(markers)), 2)
        self.assertTrue(all(not path.exists() for path in directories))

    def test_first_import_cannot_bypass_capacity_guard(self):
        with patch.object(disk, "current_image", return_value=None), \
             patch.object(disk, "cleanup"), \
             patch.object(disk, "check_space", side_effect=RuntimeError("Insufficient deployment headroom")), \
             patch.object(disk.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "headroom"):
                disk.load_image(ref("a"), str(disk.GIB))
            run.assert_not_called()

    def test_empty_source_cannot_enter_retention_history(self):
        with self.assertRaises(ValueError):
            disk.remember(None)

    def test_never_removes_used_images_protected_tags_or_other_apps(self):
        images = [
            {"Id": "active", "RepoTags": [ref("a")]},
            {"Id": "old", "RepoTags": [ref("b")]},
            {"Id": "rollback", "RepoTags": [ref("c")]},
            {"Id": "other", "RepoTags": ["dokku/other-app-staging:latest"]},
            {"Id": "dangling", "RepoTags": None},
        ]
        self.assertEqual(disk.removal_candidates(images, {ref("c")}, {"active"}), [ref("b")])

    def test_retains_two_successful_releases_across_retries(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(disk, "STATE_DIR", Path(directory)):
            for letter in "abbbc":
                disk.remember(ref(letter))
            self.assertEqual(disk.read_history(), [ref("c"), ref("b")])

    def test_cleanup_preserves_aliases_and_uses_only_nonforced_tag_removal(self):
        images = [
            {"Id": "current", "RepoTags": [ref("a"), ref("b")]},
            {"Id": "stopped", "RepoTags": [ref("c")]},
            {"Id": "old", "RepoTags": [ref("d")]},
        ]
        with patch.object(disk, "current_image", return_value=ref("a")), \
             patch.object(disk, "read_history", return_value=[]), \
             patch.object(disk, "output", side_effect=["container", " ".join(ref(c) for c in "abcd")]), \
             patch.object(disk, "inspect", side_effect=[[{"Image": "stopped"}], images]), \
             patch.object(disk.subprocess, "run") as run:
            disk.cleanup()
            self.assertEqual(run.call_args_list, [
                call(["docker", "image", "rm", ref("d")], check=True),
                call([
                    "docker", "buildx", "prune", "--all", "--force",
                    "--reserved-space", "512MB", "--max-used-space", "512MB",
                ], check=True),
            ])

    def test_monitor_fails_below_reserve(self):
        with patch.object(disk.shutil, "disk_usage", return_value=type("Usage", (), {"free": 5 * disk.GIB})()):
            with self.assertRaisesRegex(RuntimeError, "capacity attention"):
                disk.check_minimum()

    def test_invalid_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(disk, "STATE_DIR", Path(directory)):
            (Path(directory) / "successful-images.json").write_text(json.dumps(["other-app:latest"]))
            with self.assertRaises(RuntimeError):
                disk.read_history()

    def test_space_budget_accounts_for_content_and_extraction(self):
        self.assertEqual(disk.required_space(disk.GIB), 6 * disk.GIB)
        self.assertEqual(disk.required_space(3 * disk.GIB), 8 * disk.GIB)

    def test_low_disk_prevents_image_import(self):
        with patch.object(disk, "current_image", return_value=ref("a")), \
             patch.object(disk, "remember"), patch.object(disk, "cleanup"), \
             patch.object(disk, "output", return_value="/var/lib/docker"), \
             patch.object(disk.shutil, "disk_usage", return_value=type("Usage", (), {"free": disk.GIB})()), \
             patch.object(disk.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "not started"):
                disk.load_image(ref("b"), str(disk.GIB))
            run.assert_not_called()

    def test_failed_import_does_not_record_failed_release(self):
        with patch.object(disk, "current_image", return_value=ref("a")), \
             patch.object(disk, "remember") as remember, patch.object(disk, "cleanup"), \
             patch.object(disk, "check_space"), \
             patch.object(disk.subprocess, "run", side_effect=disk.subprocess.CalledProcessError(1, "dokku")):
            with self.assertRaises(disk.subprocess.CalledProcessError):
                disk.load_image(ref("b"), str(disk.GIB))
            remember.assert_called_once_with(ref("a"))

    def test_rejects_invalid_import_arguments_before_cleanup(self):
        for image, size in [("other:latest", "1"), (ref("a"), "-1"), (ref("a"), "0")]:
            with self.assertRaises(ValueError):
                disk.load_image(image, size)


if __name__ == "__main__":
    unittest.main()
