#!/usr/bin/env bash
# Isolated production-image acceptance test. Never uses host application env files.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${DATOOL_DOCKER_TEST_IMAGE:-datool:dokku-test}"
prefix="datool-image-test-$$"
temporary="$(mktemp -d)"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker logs "$prefix-web" 2>/dev/null || true
    docker logs "$prefix-worker" 2>/dev/null || true
  fi
  docker rm -fv "$prefix-web" "$prefix-worker" "$prefix-db" "$prefix-redis" >/dev/null 2>&1 || true
  docker network rm "$prefix" >/dev/null 2>&1 || true
  docker volume rm "$prefix-data" >/dev/null 2>&1 || true
  rm -rf "$temporary"
  exit "$result"
}
trap cleanup EXIT
if [ "${DATOOL_DOCKER_SKIP_BUILD:-0}" != 1 ]; then docker build -t "$image" .; fi
docker network create "$prefix" >/dev/null
docker volume create "$prefix-data" >/dev/null
docker run -d --name "$prefix-db" --network "$prefix" --network-alias database \
  -e POSTGRES_USER=datool -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=datool postgres:17-alpine >/dev/null
docker run -d --name "$prefix-redis" --network "$prefix" --network-alias redis \
  redis:7-alpine redis-server --appendonly yes --appendfsync always --maxmemory-policy noeviction >/dev/null
ready=0
for ((i=0; i<60; i++)); do
  if docker exec "$prefix-db" pg_isready -h 127.0.0.1 -U datool >/dev/null 2>&1 && docker exec "$prefix-redis" redis-cli ping >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
environment=(--network "$prefix"
  -e DATABASE_URL=postgresql://datool:isolated-test@database:5432/datool
  -e DATOOL_ALERT_DATABASE_URL=postgresql://datool_alert_reader:isolated-reader@database:5432/datool
  -e REDIS_URL=redis://redis:6379
  -e BETTER_AUTH_URL=https://localhost:3443
  -e BETTER_AUTH_SECRET=docker-test-only-secret-at-least-thirty-two-characters
  -e DATOOL_CMS_ENABLED=true
  -e PAYLOAD_SECRET=docker-test-only-payload-secret-at-least-thirty-two-characters
  -e DATOOL_PROJECT_ID=docker-test-project
  -e DATOOL_API_KEY=docker-test-only-key)
# Execute the real release command twice to verify migrations and repeatability.
release_command="$(sed -n 's/^release: //p' Procfile)"
test "$release_command" = "sh scripts/release.sh"
docker run --rm "${environment[@]}" "$image" sh scripts/release.sh
docker run --rm "${environment[@]}" "$image" sh scripts/release.sh
docker run --rm "${environment[@]}" "$image" bun run cms:seed --database datool
docker run --rm "${environment[@]}" "$image" bun run cms:seed --database datool --apply
docker run --rm "${environment[@]}" "$image" bun run cms:seed --database datool --apply
docker run --rm "${environment[@]}" "$image" bun run db:alerts-reader
docker run --rm "${environment[@]}" "$image" bun run db:alerts-reader
docker run -d --name "$prefix-web" "${environment[@]}" -v "$prefix-data:/app/.data" "$image" >/dev/null
docker run -d --name "$prefix-worker" "${environment[@]}" "$image" bun run worker:ingestion >/dev/null
ready=0
for ((i=0; i<60; i++)); do
  if docker exec "$prefix-web" node -e 'fetch("http://127.0.0.1:3000/sign-in").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
# Check rendered content: streamed Next errors can still have HTTP status 200.
docker exec "$prefix-web" node -e '
 for (const [path,text] of [["/","See what your AI is doing."],["/faq","What is Datool?"],["/faq/what-is-datool","What is Datool?"],["/landing-page.md","See what your AI is doing."]]) {
   const response=await fetch("http://127.0.0.1:3000"+path);
   if(!response.ok || !(await response.text()).includes(text)) throw new Error("CMS rendering failed: "+path);
 }
 const session=await fetch("http://127.0.0.1:3000/cms/api/cms-users/me");
 if(!session.ok || (await session.json()).user!==null) throw new Error("Anonymous CMS session endpoint failed");'
# TLS terminates in front of Next, as it does with Dokku nginx. Trust only this test CA.
[ "$(docker inspect --format '{{.State.Running}}' "$prefix-worker")" = true ]
cat > "$temporary/openssl.cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=extensions
prompt=no
[dn]
CN=localhost
[extensions]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$temporary/openssl.cnf" \
  -keyout "$temporary/key.pem" -out "$temporary/cert.pem" >/dev/null 2>&1
chmod 755 "$temporary"
chmod 644 "$temporary/key.pem"
docker cp "$temporary/." "$prefix-web:/tmp/datool-tls"
docker exec -d "$prefix-web" node -e '
 const https=require("node:https"), http=require("node:http"), fs=require("node:fs");
 https.createServer({key:fs.readFileSync("/tmp/datool-tls/key.pem"),cert:fs.readFileSync("/tmp/datool-tls/cert.pem")},(req,res)=>{
   const upstream=http.request({hostname:"127.0.0.1",port:3000,path:req.url,method:req.method,headers:{...req.headers,"x-forwarded-proto":"https"}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
   upstream.on("error",()=>{res.writeHead(502);res.end()});req.pipe(upstream);
 }).listen(3443,"0.0.0.0");'
ready=0
for ((i=0; i<30; i++)); do
  if docker exec -e NODE_EXTRA_CA_CERTS=/tmp/datool-tls/cert.pem "$prefix-web" node -e 'fetch("https://localhost:3443/sign-in").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ]
docker exec -e NODE_EXTRA_CA_CERTS=/tmp/datool-tls/cert.pem "$prefix-web" node -e '
 const response=await fetch("https://localhost:3443/api/traces",{headers:{"x-project-id":"docker-test-project"}});
 if(response.status!==401) throw new Error("Unauthenticated access was not rejected: "+response.status);
 const signup=await fetch("https://localhost:3443/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin:"https://localhost:3443"},body:JSON.stringify({email:"test@example.test",password:"test-password-123456",name:"Test"})});
 if(signup.status!==400 || !(await signup.text()).includes("EMAIL_PASSWORD_SIGN_UP_DISABLED")) throw new Error("Password signup must remain disabled");'
# Development and acceptance scripts must not ship in the production image.
docker exec "$prefix-web" node -e '
 const fs=require("node:fs");
 const expected=["alerts-worker.ts","backfill-eval-attribution.ts","backfill-missing-costs.ts","check-self-hosting.mjs","cms-local-database.ts","cms-seed-options.ts","execution-credits.ts","ingestion-jobs.ts","ingestion-worker.ts","langfuse-import.ts","migrate.ts","provision-alert-reader.ts","release.sh","seed-cms.ts"];
 if(JSON.stringify(fs.readdirSync("scripts").sort())!==JSON.stringify(expected.sort())) throw new Error("Unexpected runtime scripts");'
# Seed a project only in the disposable database, then exercise the image's HTTP APIs.
docker cp scripts/verify-v1.ts "$prefix-web:/app/scripts/verify-v1.ts"
docker cp tests/helpers/postgres.ts "$prefix-web:/app/scripts/docker-test-postgres-helper.ts"
docker exec "$prefix-web" bun -e '
 const {seedTestWorkspace}=await import("/app/scripts/docker-test-postgres-helper.ts");
 await seedTestWorkspace({databaseUrl:process.env.DATABASE_URL,ownerId:"docker-test-owner",organizationId:"docker-test-org",projectId:process.env.DATOOL_PROJECT_ID});'
# The default image gets no Docker socket. Full real-container scoring is
# covered by the shared package-verification job; this verifies the fail-closed image path.
docker exec "$prefix-web" docker --version
docker exec -e DATOOL_BASE_URL=http://127.0.0.1:3000 -e DATOOL_VERIFY_SANDBOX_UNAVAILABLE=1 "$prefix-web" bun -e '
 const {getAuth}=await import("./lib/auth.ts");
 const {db}=await import("./lib/db.ts");
 const {workspaceScopes,permissionStatements}=await import("./src/lib/auth/permissions.ts");
 try {
   const key=await getAuth().api.createApiKey({body:{organizationId:"docker-test-org",userId:"docker-test-owner",name:"Docker acceptance",permissions:permissionStatements(workspaceScopes)}});
   const child=Bun.spawn(["bun","run","verify:v1"],{env:{...process.env,DATOOL_API_KEY:key.key},stdout:"inherit",stderr:"inherit"});
   if(await child.exited!==0) throw new Error("v1 verification failed");
 } finally {await db.end()}'
docker exec "$prefix-web" bun -e '
 const {createTracer}=await import("./src/lib/tracer/sdk.ts");
 const {db}=await import("./lib/db.ts");
 try {
   await createTracer({baseUrl:"http://127.0.0.1:3000"}).trace({name:"Docker SDK canary"},async()=>({saved:true}));
   const result=await db.query("SELECT id FROM traces WHERE project_id=$1 AND name=$2 AND status=$3",[process.env.DATOOL_PROJECT_ID,"Docker SDK canary","completed"]);
   if(result.rowCount!==1) throw new Error("SDK did not persist through the worker");
 } finally {await db.end()}'
docker exec "$prefix-web" node -e '
 const fs=require("node:fs");
 if(process.getuid()===0) throw new Error("Runtime must not be root");
 for(const path of [".env.local",".env",".git","artifacts",".next/cache/turbopack",".next/cache/webpack"]) if(fs.existsSync(path)) throw new Error("Unexpected image file: "+path);
 fs.writeFileSync("/app/.data/docker-test-marker","persisted");'
docker restart "$prefix-web" >/dev/null
docker exec "$prefix-web" node -e 'if(require("node:fs").readFileSync("/app/.data/docker-test-marker","utf8")!=="persisted") process.exit(1)'
echo "Production image passed: application and CMS migrations, repeatable CMS seed, public CMS content, HTTPS/auth rejection, v1 APIs, unconfigured sandbox fails closed, SDK -> worker -> PostgreSQL, non-root runtime, persistent files."
