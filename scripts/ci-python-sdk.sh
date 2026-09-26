#!/usr/bin/env bash
set -euo pipefail

# Build once without registry credentials; every consumer and ingestion test uses
# this wheel. Release parameters are environment data, never shell source.
ci_branch=${CIRCLE_BRANCH:-${GITHUB_REF_NAME:-}}
if [ "${CI_OPERATION:-verify}" = publish-python ]; then
  test "$ci_branch" = main
  test -n "${RELEASE_VERSION:-}"
fi
uv sync --project packages/python-sdk --locked --python 3.12
uv run --project packages/python-sdk ruff check packages/python-sdk
uv run --project packages/python-sdk ruff format --check packages/python-sdk
uv run --project packages/python-sdk mypy --config-file packages/python-sdk/pyproject.toml packages/python-sdk/src/datool
uv build --project packages/python-sdk
uv run --project packages/python-sdk twine check packages/python-sdk/dist/*
uv run --project packages/python-sdk python packages/python-sdk/scripts/release.py check --dist packages/python-sdk/dist --version "${RELEASE_VERSION:-}"

python_versions=3.12
if [ "$ci_branch" = main ] || [ "${CI_OPERATION:-verify}" = publish-python ] || [ "${CI_TRIGGER_SOURCE:-}" = api ]; then
  python_versions='3.10 3.12 3.14'
fi
consumer_root=$(mktemp -d)
trap 'rm -rf "$consumer_root"' EXIT
source_root="$PWD"
uv export --project packages/python-sdk --locked --only-group langgraph --only-group agents --no-emit-project --output-file "$consumer_root/requirements.txt" > /dev/null
for python_version in $python_versions; do
  consumer="$consumer_root/consumer-$python_version"
  uv venv --python "$python_version" "$consumer"
  uv pip install --python "$consumer/bin/python" packages/python-sdk/dist/*.whl pytest -r "$consumer_root/requirements.txt"
  (cd "$consumer_root" && "$consumer/bin/python" -m pytest "$source_root/packages/python-sdk/tests" -q)
done
bun test tests/python-release-workflow.test.ts
wheels=(packages/python-sdk/dist/*.whl)
test "${#wheels[@]}" -eq 1
DATOOL_TEST_PYTHON_WHEEL="${wheels[0]}" bun run test:python:integration
