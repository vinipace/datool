#!/usr/bin/env bash
# Disposable production Compose acceptance. Never reads an operator .env file.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
image="${DATOOL_DOCKER_TEST_IMAGE:-datool:self-hosting-test}"
prefix="datool-self-hosting-$$"
temporary="$(mktemp -d)"
evidence="$root/artifacts/self-hosting/$prefix"
mkdir -p "$evidence" "$temporary/mail"
chmod 755 "$temporary"
chmod 777 "$temporary/mail"
compose() {
  env -i PATH="$PATH" HOME="$HOME" docker compose --project-directory "$root" \
    --env-file "$temporary/env" -p "$prefix" -f compose.yaml -f "$temporary/compose.test.yaml" "$@"
}
sandbox() {
  compose -f compose.sandbox.yaml "$@"
}
cleanup() {
  result=$?
  if [ -f "$temporary/compose.test.yaml" ]; then
    compose logs --no-color > "$evidence/containers.log" 2>&1 || true
    compose down -v --remove-orphans > /dev/null 2>&1 || true
  fi
  rm -rf "$temporary"
  if [ "$result" -ne 0 ]; then echo "Self-hosting test failed. Evidence: $evidence" >&2; fi
  exit "$result"
}
trap cleanup EXIT
if [ "${DATOOL_DOCKER_SKIP_BUILD:-0}" != 1 ]; then docker build -t "$image" .; fi
docker pull node:22-bookworm-slim > /dev/null
docker pull python:3.13-slim > /dev/null
socket_group="$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$image" stat -c '%g' /var/run/docker.sock)"
port="$(node --input-type=module -e 'import net from "node:net"; const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')"
cat > "$temporary/env" <<ENV
DATOOL_IMAGE=$image
POSTGRES_PASSWORD=$(openssl rand -hex 32)
DATOOL_ALERT_READER_PASSWORD=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
BETTER_AUTH_URL=https://localhost:$port
AUTH_ALLOWED_DOMAINS=example.test
RESEND_API_KEY=self-hosting-fixture-only
RESEND_FROM_EMAIL=signin@example.test
GOOGLE_CLIENT_ID=self-hosting-test.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=self-hosting-fixture-only
DATOOL_CMS_ENABLED=false
DATOOL_HTTP_PORT=0
DATOOL_DOCKER_GID=$socket_group
ENV
chmod 600 "$temporary/env"
cp tests/fixtures/self-hosting/*.mjs "$temporary/"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$temporary/key.pem" -out "$temporary/cert.pem" > /dev/null 2>&1
chmod 644 "$temporary/key.pem"
cat > "$temporary/compose.test.yaml" <<YAML
services:
  app:
    environment:
      NODE_OPTIONS: --import=/test-fixtures/mail.mjs
    volumes:
      - $temporary:/test-fixtures:ro
      - $temporary/mail:/test-mail
  proxy:
    image: $image
    command: [node, /test-fixtures/proxy.mjs]
    ports:
      - "127.0.0.1:$port:3443"
    volumes:
      - $temporary:/test-fixtures:ro
    depends_on:
      app:
        condition: service_healthy
YAML
run_browser() {
  env -i PATH="$PATH" HOME="$HOME" NODE_EXTRA_CA_CERTS="$temporary/cert.pem" \
    DATOOL_TEST_ORIGIN="https://localhost:$port" DATOOL_TEST_DIRECTORY="$temporary" \
    DATOOL_TEST_EVIDENCE="$evidence" \
    node --import tsx scripts/test-self-hosting-browser.ts "$1"
}
compose up -d --no-build --wait --wait-timeout 180
[ "$(compose exec -T postgres psql -U datool -Atc "SELECT count(*) FROM pg_namespace WHERE nspname='payload'")" = 0 ]
run_browser bootstrap
compose exec -T app node -e '
 const fs=require("node:fs");
 if(process.getuid()===0) throw new Error("Runtime must be non-root");
 for(const path of [".env",".env.local",".git","artifacts"]) if(fs.existsSync(path)) throw new Error("Unexpected image file: "+path);
 fs.writeFileSync("/app/.data/self-hosting-test-marker","persisted");'
compose exec -T worker node -e 'if(require("node:fs").readFileSync("/app/.data/self-hosting-test-marker","utf8")!=="persisted") process.exit(1)'
# Explicit opt-in: the same image now gets access to the sandbox daemon.
sandbox up -d --no-build --wait --wait-timeout 180
run_browser sandbox
# Remove containers but preserve volumes, then migrate and recreate from scratch.
sandbox down
sandbox up -d --no-build --wait --wait-timeout 180
run_browser restart
sandbox exec -T app node -e 'if(require("node:fs").readFileSync("/app/.data/self-hosting-test-marker","utf8")!=="persisted") process.exit(1)'
sandbox exec -T worker node -e 'if(require("node:fs").readFileSync("/app/.data/self-hosting-test-marker","utf8")!=="persisted") process.exit(1)'
# Turn CMS on at runtime using the same image and the same existing database.
node --input-type=module -e '
 import fs from "node:fs"; import crypto from "node:crypto";
 const file=process.argv[1]; fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace("DATOOL_CMS_ENABLED=false","DATOOL_CMS_ENABLED=true")+"PAYLOAD_SECRET="+crypto.randomBytes(32).toString("hex")+"\n");
' "$temporary/env"
sandbox run --rm migrate
sandbox up -d --no-build --wait --wait-timeout 180
sandbox exec -T app bun run cms:seed --database datool
sandbox exec -T app bun run cms:seed --database datool --apply
sandbox exec -T app bun run cms:seed --database datool --apply
run_browser cms
# No fixture token, session, API key, or mail capture is copied to evidence.
echo "Production Compose passed: real first login, workspace creation, CMS off/on, queued SDK persistence, sandbox off/on, and recreation with existing volumes. Evidence: $evidence"
