# Project deployment example

Use a CLI built from this checkout (the published 0.4.1 CLI predates deployment):

```sh
bun run scripts/build-packages.ts cli
DATOOL_BASE_URL=http://127.0.0.1:3000 DATOOL_PROJECT_ID=your-project-id DATOOL_API_KEY=your-key node packages/cli/dist/datool.js deploy examples/project-deployment
```

The server needs migration 0091 and a configured organization sandbox. For local Docker, pull `node:22-bookworm-slim` before deploying. No model provider is required to deploy or call the MCP tools; agent conversations require one.

`search_projects` reads the managed `projects` collection, which starts empty. `brain_search` searches the company document and collector output. See the project deployment guide for tools that write database records, buckets and use sandbox capabilities.
