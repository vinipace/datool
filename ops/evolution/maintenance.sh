#!/usr/bin/env bash
# Root-only local recovery copies. Off-host encrypted backup is configured by the operator.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
exec 9>/run/datool-evolution-maintenance.lock
flock -n 9 || exit 0
root=/var/backups/datool-evolution
install -d -m 0700 "$root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Provider messages only support recent delivery receipts. Datool owns inbox history.
cat <<'SQL' | dokku postgres:connect evolution-db >/dev/null
DELETE FROM "Message" WHERE "messageTimestamp" < EXTRACT(EPOCH FROM now() - INTERVAL '3 days')::bigint;
SQL
# A transactionally consistent PostgreSQL dump includes the authoritative Session table.
dokku postgres:export evolution-db > "$root/$stamp.dump.partial"
test -s "$root/$stamp.dump.partial"
mv "$root/$stamp.dump.partial" "$root/$stamp.dump"
# CACHE_REDIS_SAVE_INSTANCES=false: Redis is a cache, not the session authority.
tar -czf "$root/$stamp-storage.tgz" -C /var/lib/dokku/data/storage/datool-evolution instances
find "$root" -maxdepth 1 -type f \( -name '*.dump' -o -name '*-storage.tgz' -o -name '*.partial' \) -mtime +7 -delete
logger -t datool-evolution 'maintenance completed: retention and local backup'
