"""Install this standalone native plugin into one Hermes profile."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")))
    parser.add_argument("--hermes", default="hermes", help="Hermes executable")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    target = args.home.resolve() / "plugins" / "datool"
    if target.exists() and (target / "plugin.yaml").exists():
        if "author: Datool" not in (target / "plugin.yaml").read_text():
            parser.error("A different plugin already occupies plugins/datool")
    target.mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "plugin.yaml"):
        shutil.copy2(source / name, target / name)
    env = {**os.environ, "HERMES_HOME": str(args.home.resolve())}
    # Prompted API keys never enter the shell history or command arguments.
    subprocess.run([sys.executable, str(target / "__init__.py"), "configure"], env=env, check=True)
    subprocess.run([args.hermes, "plugins", "enable", "datool", "--no-allow-tool-override"], env=env, check=True)
    print("Datool installed and enabled. Restart running Hermes CLI/gateway processes to start tracing.")
    print("Check delivery: hermes datool status | Retry pending events: hermes datool flush")


if __name__ == "__main__":
    main()
