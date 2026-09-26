# Local ingestion load tests

The load harness sends real authenticated HTTP requests to the production Docker image, through Redis and the ingestion worker into PostgreSQL. Every phase reconciles unique event IDs with PostgreSQL receipts and checks final trace/span counts and output payloads. HTTP acceptance alone is not a pass.

Use the standalone `compose.load.yaml` with a dedicated `datool-load` project. It has its own fixture credentials, volumes, and loopback ports; it does not inherit the self-hosting Compose configuration or an operator's `.env`. CMS, billing, and managed execution are disabled. The interruption phases SIGKILL only its worker, PostgreSQL, or Redis service, wait four seconds, and restart that service. Do not reuse this project name for normal development data.

```bash
docker compose --env-file /dev/null -p datool-load -f compose.load.yaml up --build -d --wait

bun run test:load
# Or run one phase:
bun run test:load burst

# Exercise organization-key throttling and retry recovery:
DATOOL_LOAD_KEY_LIMIT=100 DATOOL_LOAD_KEY_WINDOW_MS=1000 bun run test:load baseline
```

The stack uses the same `Dockerfile` as self-hosting. To reuse an already built image, set `DATOOL_LOAD_IMAGE=your-image:tag` and replace `--build` with `--no-build`. Published ports default to 3040 (HTTP), 55441 (PostgreSQL), and 56381 (Redis); set `DATOOL_LOAD_HTTP_PORT`, `DATOOL_LOAD_POSTGRES_PORT`, and `DATOOL_LOAD_REDIS_PORT` when starting Compose to override them. Set `DATOOL_LOAD_PROJECT=datool-load-suffix` for the harness when using a different dedicated project name.

The harness discovers the stack's published ports and verifies its fixture labels before connecting, seeding, or interrupting services. It rejects non-loopback bindings, unrelated containers, and dynamically allocated ports (`0`), which Docker can reassign during a restart. App and worker containers use the production restart policy so they recover after a dependency outage. Run through `bun run test:load`, which disables automatic env-file loading; production database URLs and provider credentials are not used.

Every run creates a temporary organization API key inside the application container and deletes the key afterward. The key never appears in reports. The default test quota is 100,000 requests per minute so ordinary load phases measure ingestion rather than throttling; quota overrides affect only that key. The production default quota is unchanged. The fixture's HTTPS auth issuer satisfies production configuration, while the local bearer-token endpoint uses HTTP. This stack does not test interactive login; use `bun run test:self-hosting` for that.

Phases: baseline (4 producers), burst (32 producers, duplicate delivery), 32 KiB payloads, worker crash, database outage, and Redis outage. Each trace includes lifecycle create/patch events for itself and each span. Producers send sequentially within their own stream and concurrently across streams, matching the processor's predecessor ordering. This is a closed-loop burst test, not a sustained open-loop rate guarantee.

JSON results in `artifacts/load-tests/` record counts, retry/HTTP outcomes, payload volume, acknowledgement p50/p95/p99, commit p50/p95/p99, total drain time, failed jobs, and Redis memory. A phase has a three-minute drain budget and fails if expected data remains missing, output differs, a terminal request error occurs, or failed jobs remain. Accepted-but-pending events are not automatically classified as lost.

To stop the dedicated stack while retaining fixture data for inspection:

```bash
docker compose --env-file /dev/null -p datool-load -f compose.load.yaml down
```

Add `--volumes` to remove its disposable data. Reports remain in `artifacts/load-tests/`.

These measurements depend on this machine, workload, persistence settings, and worker count. They do not establish sustained production capacity, multi-node Redis/PostgreSQL failover guarantees, or a zero-loss guarantee for events killed in a producer before queue acceptance.

Run the harness against the current revision to measure throughput and recovery. Keep measured results and raw execution evidence under ignored `artifacts/`.
