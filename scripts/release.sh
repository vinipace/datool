#!/bin/sh
set -eu

# Dokku executes Procfile commands directly, so sequence release tasks here.
bun run db:migrate
if [ "${DATOOL_CMS_ENABLED:-false}" = true ]; then
  test -n "${PAYLOAD_SECRET:-}" || { echo "PAYLOAD_SECRET is required when DATOOL_CMS_ENABLED=true." >&2; exit 1; }
  bun run cms:migrate
fi
