#!/usr/bin/env bash
# Provision a separate managed Evolution service. Run as root after review.
# No Datool restart and no customer number is paired by this script.
set -euo pipefail
umask 077
resume=false
case "${1:-}" in
  "") ;;
  --resume-after-redis-permissions) resume=true ;;
  *) echo "Unknown bootstrap option" >&2; exit 1 ;;
esac
[[ $(id -u) == 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
exec 9>/run/datool-evolution-bootstrap.lock
flock -n 9 || { echo 'Another Evolution bootstrap is running.' >&2; exit 1; }
app=datool-evolution
network=datool-evolution-net
image='evoapicloud/evolution-api@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$source_dir/safe-logs.cjs" && -f "$source_dir/maintenance.sh" ]] || { echo 'Missing safe-logs.cjs'; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'Expected the verified amd64 target.'; exit 1; }
[[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -ge 3500000 ]] || { echo 'Insufficient available memory.'; exit 1; }
[[ $(df -Pk /var/lib/docker | awk 'NR==2 {print $4}') -ge 12000000 ]] || { echo 'Insufficient Docker disk space.'; exit 1; }
# Dokku 0.38 global help omits core subcommands; query each plugin directly.
for command in apps:create postgres:create redis:create network:set checks:disable git:from-image resource:limit; do
  dokku_commands=$(dokku "${command%%:*}:help") || { echo "Unable to read Dokku help for $command" >&2; exit 1; }
  grep -E "^[[:space:]]*$command([[:space:],]|$)" <<< "$dokku_commands" >/dev/null || { echo "Missing Dokku command: $command"; exit 1; }
done
unset dokku_commands
if "$resume"; then
  # This recovery path only accepts the undeployed checkpoint before service links.
  dokku apps:exists "$app" >/dev/null
  [[ -z "$(dokku config:get "$app" AUTHENTICATION_API_KEY)" ]] || { echo 'Recovery refused: Evolution already has credentials.'; exit 1; }
  [[ ! -e /var/lib/dokku/data/storage/datool-evolution ]] || { echo 'Recovery refused: Evolution storage already exists.'; exit 1; }
  [[ "$(docker inspect -f '{{.Config.Image}}' dokku.redis.evolution-redis)" == redis:7-alpine ]] || { echo 'Recovery refused: unexpected Redis image.'; exit 1; }
  [[ "$(docker inspect -f '{{.Config.Image}}' dokku.postgres.evolution-db)" == postgres:15-alpine ]] || { echo 'Recovery refused: unexpected PostgreSQL image.'; exit 1; }
  [[ -z "$(docker ps -aq --filter "label=com.dokku.app-name=$app")" ]] || { echo 'Recovery refused: Evolution already has an application container.'; exit 1; }
else
  if dokku apps:exists "$app" >/dev/null 2>&1; then
    echo 'Evolution app already exists; inspect it and use the upgrade runbook. No changes made.'
    exit 1
  fi
  for service in evolution-db evolution-redis; do
    if [[ -d /var/lib/dokku/services/postgres/$service || -d /var/lib/dokku/services/redis/$service ]]; then
      echo "Service $service already exists; inspect partial provisioning before retrying."
      exit 1
    fi
  done
fi
record="/root/evolution-bootstrap-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1
exec >"$record" 2>&1
trap 'printf "Provisioning stopped. Private diagnostics: %s\n" "$record" >&3' ERR
printf 'Provisioning separate Evolution app; private diagnostics: %s\n' "$record" >&3
# Stop before any mutation if existing Meta identities cannot be backfilled safely.
cat <<'SQL' | dokku postgres:connect datool-db >/dev/null
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM build_whatsapp_account WHERE regexp_replace(display_phone_number,'[^0-9]','','g') !~ '^[1-9][0-9]{6,19}$')
 OR EXISTS (SELECT 1 FROM build_whatsapp_account GROUP BY regexp_replace(display_phone_number,'[^0-9]','','g') HAVING count(*)>1)
 THEN RAISE EXCEPTION 'Resolve existing WhatsApp number conflicts before release'; END IF;
END $$;
SQL
install -d -m 0700 /var/backups/datool-evolution
backup="/var/backups/datool-evolution/datool-before-evolution-$(date -u +%Y%m%dT%H%M%SZ).dump"
dokku postgres:export datool-db > "$backup"
test -s "$backup"
docker pull "$image"
if "$resume"; then
  # Preserve the protected service parent and config owner. Only the Redis
  # container's group gains read/traverse access to its mounted configuration.
  redis_config=/var/lib/dokku/services/redis/evolution-redis/config
  [[ -d "$redis_config" && ! -L "$redis_config" && -f "$redis_config/redis.conf" && ! -L "$redis_config/redis.conf" ]]
  redis_gid=$(docker run --rm --network none --entrypoint id redis:7-alpine -g redis)
  [[ "$redis_gid" =~ ^[0-9]+$ ]]
  chgrp "$redis_gid" "$redis_config" "$redis_config/redis.conf"
  chmod 2750 "$redis_config"
  chmod 0640 "$redis_config/redis.conf"
  dokku redis:restart evolution-redis
else
  dokku apps:create "$app"
  dokku postgres:create evolution-db --image-version 15-alpine --memory 512 --config-options '-c max_connections=60'
  # Dokku creates a mounted config before Redis drops privileges. Do not pass
  # the private backup/log umask into the service's configuration creation.
  (umask 022; dokku redis:create evolution-redis --image-version 7-alpine --memory 128 --config-options '--appendonly yes --maxmemory 96mb --maxmemory-policy noeviction')
fi
redis_ready=false
for attempt in $(seq 1 15); do
  if [[ "$(REDISCLI_AUTH=$(cat /var/lib/dokku/services/redis/evolution-redis/PASSWORD) docker exec -e REDISCLI_AUTH dokku.redis.evolution-redis redis-cli ping 2>/dev/null)" == PONG ]]; then
    redis_ready=true
    break
  fi
  sleep 2
done
"$redis_ready"
printf 'Redis authentication and readiness verified. Continuing Evolution setup.\n' >&3
dokku postgres:link evolution-db "$app"
dokku redis:link evolution-redis "$app"
database_url=$(dokku config:get "$app" DATABASE_URL)
redis_url=$(dokku config:get "$app" REDIS_URL)
api_key=$(openssl rand -hex 32)
storage=/var/lib/dokku/data/storage/datool-evolution
install -d -m 0700 "$storage/instances"
install -m 0444 "$source_dir/safe-logs.cjs" "$storage/safe-logs.cjs"
dokku storage:mount "$app" "$storage/instances:/evolution/instances"
dokku storage:mount "$app" "$storage/safe-logs.cjs:/evolution/safe-logs.cjs:ro"
docker network inspect "$network" >/dev/null 2>&1 || docker network create --attachable "$network"
dokku network:set "$app" attach-post-create "$network"
# Preserve the Datool installation's existing attached networks.
read -r -a existing_networks <<< "$(dokku network:report datool --network-computed-attach-post-create)"
if [[ " ${existing_networks[*]} " != *" $network "* ]]; then
  dokku network:set datool attach-post-create "${existing_networks[@]}" "$network"
fi
dokku network:set "$app" bind-all-interfaces false
dokku network:set "$app" tld internal
dokku proxy:disable "$app"
dokku checks:disable "$app" web
dokku resource:limit "$app" --memory 1536m --cpu 1
dokku ps:set "$app" restart-policy unless-stopped
dokku config:set --no-restart "$app" \
  SERVER_URL="http://$app.web.internal:8080" SERVER_PORT=8080 \
  DATABASE_PROVIDER=postgresql DATABASE_CONNECTION_URI="$database_url" \
  DATABASE_CONNECTION_CLIENT_NAME=datool-evolution \
  CACHE_REDIS_ENABLED=true CACHE_REDIS_URI="$redis_url" CACHE_REDIS_SAVE_INSTANCES=false \
  AUTHENTICATION_API_KEY="$api_key" AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false \
  DATABASE_SAVE_DATA_INSTANCE=true DATABASE_SAVE_DATA_NEW_MESSAGE=true \
  DATABASE_SAVE_MESSAGE_UPDATE=false DATABASE_SAVE_DATA_CONTACTS=false \
  DATABASE_SAVE_DATA_CHATS=false DATABASE_SAVE_DATA_HISTORIC=false \
  LOG_LEVEL=ERROR LOG_BAILEYS=silent LOG_COLOR=false TELEMETRY_ENABLED=false \
  NODE_OPTIONS=--require=/evolution/safe-logs.cjs \
  WEBHOOK_GLOBAL_ENABLED=false DEL_INSTANCE=false >/dev/null
# Backend configuration only. An explicit project allowlist is needed to activate.
dokku config:set --no-restart datool \
  DATOOL_EVOLUTION_URL="http://$app.web.internal:8080" DATOOL_EVOLUTION_API_KEY="$api_key" \
  DATOOL_EVOLUTION_ENABLED=false DATOOL_EVOLUTION_PROJECT_IDS='' DATOOL_EVOLUTION_MAX_INSTANCES=3 >/dev/null
unset api_key database_url redis_url
# Original prebuilt image, not a build on the production host.
dokku git:from-image "$app" "$image"
container=$(docker ps -q --filter "label=com.dokku.app-name=$app" --filter 'label=com.dokku.process-type=web')
[[ -n "$container" && $(printf '%s\n' "$container" | wc -l) -eq 1 ]]
for attempt in $(seq 1 30); do
  if docker exec "$container" node -e 'fetch("http://127.0.0.1:8080/").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then
    install -d -m 0700 /opt/datool-evolution
    install -m 0700 "$source_dir/maintenance.sh" /opt/datool-evolution/maintenance.sh
    /opt/datool-evolution/maintenance.sh
    printf '17 3 * * * root /opt/datool-evolution/maintenance.sh 2>&1 | logger -t datool-evolution\n' > /etc/cron.d/datool-evolution
    chmod 0644 /etc/cron.d/datool-evolution
    if [[ -f "$source_dir/discover-containers.py" && -x /usr/local/libexec/datool-log-discovery ]]; then
      cp -p /usr/local/libexec/datool-log-discovery /opt/datool-evolution/log-discovery.before.py
      install -o root -g root -m 0700 "$source_dir/discover-containers.py" /usr/local/libexec/datool-log-discovery
      /usr/local/libexec/datool-log-discovery
    fi
    printf 'Evolution deployed and HTTP-ready. Datool pilot remains disabled. No number connected.\n' >&3
    exit 0
  fi
  sleep 2
done
exit 1
