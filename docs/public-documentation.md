# Maintaining public documentation

Public reader-facing pages live in `content/docs/`. The `docs/` directory also contains internal design and operational material; do not publish it wholesale. Keep installation-specific access details and execution artifacts out of public pages.

## Generated references

Run `bun run generate:api` after changing an agent operation or a service response type. Commit all resulting changes:

- `src/server/mcp/output-schemas.json` contains response contracts inferred from the actual `TracerEffect` callback results in `src/server/mcp/operations.ts`.
- `content/docs/reference/operations.mdx` summarizes registered input and response fields and scopes.
- The generated section of `content/docs/reference/cli.mdx` mirrors the CLI's help literals.

The output generator uses the TypeScript compiler without executing services or opening a database. It preserves nullable values, omits undefined object properties, and retains open JSON for application-defined payloads. Unsupported types and unresolved `any` fail generation. Add a precise service response type when necessary; do not edit generated schemas to mask a mismatch. These schemas describe serialized results; they do not add runtime output validation or change operation behavior.

`bun run check:docs` detects reference drift and verifies metadata, navigation, internal links, local illustration files, copyable JSON/filter examples, response schemas, and the exact prompt tutorial (latest publication and optional version comparisons). `bun test tests/agent-readiness.test.ts` validates OpenAPI 3.1, references, strict inputs, and scopes.

## Reader workflows

Each tutorial should give installation/access prerequisites, runtime/package versions, credential scopes, complete files, execution commands, expected results, and recovery steps. Use the published versions listed in the compatibility page. Source package versions do not establish that a release is publicly installable.

Before changing an integration recipe, execute its copied code against a disposable project using the stated package versions. Check saved evidence, not only successful process exit. For evaluations, verify both a deliberately failing baseline gate and a passing candidate gate. Distinguish real provider calls from mock-model telemetry tests and locally built preview wheels from public package releases.

Use synthetic example data for product illustrations. See `public/docs-assets/README.md`. Keep test credentials and raw execution exports in ignored `artifacts/` or outside the repository.

## Publication checks

```sh
bun run check:docs
bun test tests/agent-readiness.test.ts
bun run check:docs:links
bun run check:pre-push
bun run build
```

The external link check performs anonymous GETs and fails on inaccessible destinations. It is separate from the build so a third-party outage does not invalidate otherwise valid source. Browser-check the changed reader journey and a narrow mobile layout. Verify deployed pages separately after release; a local build does not establish publication.

Against a running build, use `DOCS_TEST_URL=http://127.0.0.1:3000 bun run test:docs:http` to verify every docs page through `Accept: text/markdown` and its `.md` URL. It also checks the Markdown button, metadata and discovery links, HEAD responses, missing pages, HTML preference, cache separation, and tab contents. Removed `/docs/markdown/...` URLs must return 404 without redirects. These checks need no project credentials or database.
