#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test_run="datool-backup-test-$(date +%s)-$$"
test_image="${test_run}:local"
cleanup() {
  docker rm -fv "${test_run}-runner" "${test_run}-db" "${test_run}-cache" >/dev/null 2>&1 || true
  docker network rm "$test_run" >/dev/null 2>&1 || true
  docker image rm "$test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -f Dockerfile.test -t "$test_image" .
docker network create --internal "$test_run" >/dev/null
docker run -d --name "${test_run}-db" --network "$test_run" --network-alias db \
  -e POSTGRES_PASSWORD=synthetic-test-only postgres:17-alpine >/dev/null
docker run -d --name "${test_run}-cache" --network "$test_run" --network-alias cache \
  redis:7-alpine >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "${test_run}-db" pg_isready -U postgres >/dev/null 2>&1 \
     && docker exec "${test_run}-cache" redis-cli ping >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Disposable databases did not become ready' >&2
  exit 1
fi
docker run --name "${test_run}-runner" --network "$test_run" "$test_image"
