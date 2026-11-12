# Drizzle PostgreSQL deployment

`schema.ts` owns the database types. The generated helper supplies `ctx.sql` to
both tools and read-only sources. This example includes an enum, an upsert tool,
a query tool and a source collector.

Use a server with migration 0092, an organization sandbox, and
`DATOOL_PROJECT_DATABASE_ADMIN_URL`. Use the CLI and SDK built from the same
checkout; the previously published releases do not include this feature.

From the repository, build and pack the packages:

```sh
bun run pack:packages
cp -R examples/project-postgres /tmp/datool-postgres-example
npm install --prefix /tmp/datool-postgres-example "$PWD/artifacts/npm/datool-sdk-0.3.2.tgz" drizzle-orm
```

Copying the example out of the monorepo and installing the SDK tarball keeps all
bundled runtime dependencies inside the deployment folder. Set `DATOOL_BASE_URL`,
`DATOOL_PROJECT_ID` and `DATOOL_API_KEY`, then run from the repository:

```sh
node packages/cli/dist/datool.js deploy /tmp/datool-postgres-example --dry-run
node packages/cli/dist/datool.js deploy /tmp/datool-postgres-example --plan
node packages/cli/dist/datool.js deploy /tmp/datool-postgres-example
```

Call `save_project` with an ID, name and status, then call `search_projects`.
Redeploy to refresh the company brain. Add a nullable column to `schema.ts` and
redeploy to apply a migration while preserving the saved records. The CLI writes
applied SQL to `migrations/`; identical schemas do not generate another migration.
