import importlib.machinery
import importlib.util
from pathlib import Path
import shlex
import unittest

source = Path(__file__).resolve().parents[1] / "ops/dokku-deploy/deploy-command"
loader = importlib.machinery.SourceFileLoader("datool_deploy", str(source))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

class RestrictedDeployTest(unittest.TestCase):
    def test_permits_ci_commands(self):
        for command in ["ps:report datool", "ps:report datool --running", "disk:status datool",
                        "disk:load-image datool datool-release:" + "a" * 40 + "-123-1 2031860368"]:
            args = shlex.split(command)
            self.assertEqual(module.validate(args), args)

    def test_denies_other_access_and_injection(self):
        for command in ["", "sh", "config:show datool", "ps:report another-app",
                        "disk:status another-app", "disk:cleanup datool",
                        "ps:report datool; id", "ps:report datool --running extra",
                        "disk:load-image other datool-release:" + "a"*40 + "-1-1 100",
                        "disk:load-image datool bad-image 100",
                        "disk:load-image datool datool-release:" + "a"*40 + "-1-1 0",
                        "disk:load-image datool datool-release:" + "a"*40 + "-1-1 99999999999",
                        "ps:report $(id)"]:
            with self.subTest(command=command), self.assertRaises(ValueError):
                module.validate(shlex.split(command))

if __name__ == "__main__":
    unittest.main()
