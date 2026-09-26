import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "ops/gcp-logging/discover-containers.py"
spec = importlib.util.spec_from_file_location("datool_log_discovery", MODULE_PATH)
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


def container(name, char="a", path=None):
    identifier = char * 64
    return {"Name": name, "Id": identifier,
            "LogPath": path or f"/var/lib/docker/containers/{identifier}/{identifier}-json.log"}


class DiscoveryTests(unittest.TestCase):
    def test_only_named_datool_services_are_exported(self):
        records = [container("/datool.web.1"), container("/datool.worker.1", "b"),
                   container("/dokku.postgres.datool-db", "c"),
                   container("/dokku.redis.datool-redis", "d"),
                   container("/other.web.1", "e"), container("/datool.web.1-evil", "f"),
                   container("/datool.run.123", "1")]
        self.assertEqual(len(discovery.selected_logs(records)), 4)

    def test_unexpected_driver_or_path_is_rejected(self):
        for path in ("/etc/shadow", "", "/var/lib/docker/containers/../secrets"):
            record = container("/datool.web.1")
            record["LogPath"] = path
            with self.assertRaises(RuntimeError):
                discovery.selected_logs([record])

    def test_new_container_id_gets_distinct_log_source(self):
        first = discovery.selected_logs([container("/datool.web.1", "a")])
        replacement = discovery.selected_logs([container("/datool.web.1", "b")])
        self.assertTrue(set(first).isdisjoint(replacement))

    def test_invalid_container_id_cannot_enter_path(self):
        record = container("/datool.web.1")
        record["Id"] = "../elsewhere"
        self.assertEqual(discovery.selected_logs([record]), {})


if __name__ == "__main__":
    unittest.main()
