"""Build a reproducible, source-only Hermes plugin ZIP and SHA-256 checksum."""
import argparse
import hashlib
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ("__init__.py", "plugin.yaml", "install.py", "README.md")


def plugin_version(source):
    # Keep the packager dependency-free; release versions are stable x.y.z values.
    values = re.findall(r"^version:([^\r\n]*)$", (source / "plugin.yaml").read_text(), re.MULTILINE)
    if len(values) != 1:
        raise ValueError("plugin.yaml must declare one stable x.y.z version")
    version = values[0].strip()
    if len(version) >= 2 and version[0] in "\"'" and version[-1] == version[0]:
        version = version[1:-1]
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("plugin.yaml must declare one stable x.y.z version")
    return version


def build_bundle(source, output_dir, *, tag=None, output=None):
    payloads = {}
    for name in FILES:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Expected a regular plugin source file: {name}")
        payloads[name] = path.read_bytes()
    version = plugin_version(source)
    if tag is not None and tag != f"hermes-v{version}":
        raise ValueError(f"Release tag must match plugin.yaml: hermes-v{version}")
    output = output or output_dir / f"datool-hermes-{version}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, data in payloads.items():
            entry = zipfile.ZipInfo(f"datool-hermes/{name}", (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(entry, data)
    checksum = output.with_suffix(output.suffix + ".sha256")
    checksum.write_text(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output.name}\n")
    return output, checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    destination = parser.add_mutually_exclusive_group()
    destination.add_argument("--output", type=Path, help="Explicit ZIP filename (legacy option)")
    destination.add_argument("--output-dir", type=Path, default=ROOT / ".data/hermes-distribution")
    parser.add_argument("--tag", help="Require this release tag to match the plugin version")
    args = parser.parse_args()
    try:
        paths = build_bundle(ROOT / "integrations/hermes", args.output_dir,
                             tag=args.tag, output=args.output)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    for path in paths:
        print(path.resolve())


if __name__ == "__main__":
    main()
