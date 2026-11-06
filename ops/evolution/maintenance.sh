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
# PostgreSQL stores the login credentials; Redis also stores Signal session keys.
dokku postgres:export evolution-db > "$root/$stamp.dump.partial"
test -s "$root/$stamp.dump.partial"
mv "$root/$stamp.dump.partial" "$root/$stamp.dump"
# SAVE_INSTANCES=false does not move Signal keys out of Redis in Evolution 2.3.7.
# The installed Dokku Redis exporter assumes bash, absent from redis:7-alpine.
redis_snapshot="/tmp/datool-evolution-$stamp.rdb"
export REDISCLI_AUTH
REDISCLI_AUTH=$(cat /var/lib/dokku/services/redis/evolution-redis/PASSWORD)
trap 'docker exec dokku.redis.evolution-redis rm -f "$redis_snapshot" >/dev/null 2>&1 || true' EXIT
docker exec -e REDISCLI_AUTH dokku.redis.evolution-redis sh -c "umask 077; exec redis-cli --rdb $redis_snapshot" >/dev/null 2>&1
unset REDISCLI_AUTH
docker exec dokku.redis.evolution-redis redis-check-rdb "$redis_snapshot" >/dev/null
docker cp "dokku.redis.evolution-redis:$redis_snapshot" "$root/$stamp-redis.rdb.partial"
docker exec dokku.redis.evolution-redis rm -f "$redis_snapshot"
trap - EXIT
test -s "$root/$stamp-redis.rdb.partial"
mv "$root/$stamp-redis.rdb.partial" "$root/$stamp-redis.rdb"
tar -czf "$root/$stamp-storage.tgz" -C /var/lib/dokku/data/storage/datool-evolution instances
find "$root" -maxdepth 1 -type f \( -name '*.dump' -o -name '*-storage.tgz' -o -name '*-redis.rdb' -o -name '*.partial' \) -mtime +7 -delete
logger -t datool-evolution 'maintenance completed: retention and local backup'
