#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $EUID != 0 || $# != 2 ]]; then
  echo 'Usage: sudo bash install.sh /absolute/path/to/logging-service-account.json expected-service-account-email' >&2
  exit 1
fi
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CREDENTIALS=$1
test "$(dpkg --print-architecture)" = amd64
. /etc/os-release
test "$ID" = debian
test "$VERSION_CODENAME" = trixie
if [[ -e /etc/datool-logging || -L /etc/datool-logging ]]; then
  echo '/etc/datool-logging already exists; review and update the existing installation explicitly.' >&2
  exit 1
fi
python3 - "$CREDENTIALS" "$SOURCE_DIR/fluent-bit.conf" "$2" <<'PY'
import json, sys
from pathlib import Path
config = Path(sys.argv[2]).read_text()
assert 'YOUR_' not in config, 'Configure the collector project, location, namespace, and node ID first'
projects = [line.split()[1] for line in config.splitlines()
            if line.strip().startswith('export_to_project_id ')]
assert len(projects) == 1, 'Expected one destination project'
with open(sys.argv[1]) as handle:
    key = json.load(handle)
assert key.get('type') == 'service_account', 'Expected a service-account key'
assert key.get('project_id') == projects[0], 'Credential and destination projects differ'
assert sys.argv[3].endswith('@' + projects[0] + '.iam.gserviceaccount.com'), 'Expected identity must belong to the destination project'
assert key.get('client_email') == sys.argv[3], 'Unexpected identity'
assert key.get('private_key', '').startswith('-----BEGIN PRIVATE KEY-----'), 'Missing key'
PY

# Pin the vendor's Debian 13 package. No application build or service restart.
PACKAGE_DIR=$(mktemp -d /var/tmp/datool-logging-package.XXXXXX)
trap 'rm -rf -- "$PACKAGE_DIR"' EXIT
curl --fail --silent --show-error --retry 3 --connect-timeout 15 --max-time 180 \
  https://packages.fluentbit.io/debian/trixie/pool/main/f/fluent-bit/fluent-bit_4.2.8_amd64.deb \
  -o "$PACKAGE_DIR/fluent-bit.deb"
printf '%s  %s\n' 352441f87b20e8364986ad22eba6eb8804354ef5fe96a1d0c82c184aa14a8eec \
  "$PACKAGE_DIR/fluent-bit.deb" | sha256sum --check --status
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$PACKAGE_DIR/fluent-bit.deb"

install -d -o root -g root -m 0700 /etc/datool-logging /var/lib/datool-logging \
  /var/lib/datool-logging/buffer /var/log/datool-logging /var/log/datool-logging/containers
install -o root -g root -m 0400 "$CREDENTIALS" /etc/datool-logging/credentials.json
for file in fluent-bit.conf parsers.conf normalize.lua; do
  install -o root -g root -m 0600 "$SOURCE_DIR/$file" "/etc/datool-logging/$file"
done
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0700 "$SOURCE_DIR/discover-containers.py" /usr/local/libexec/datool-log-discovery
for unit in datool-logging.service datool-log-discovery.service datool-log-discovery.timer; do
  install -o root -g root -m 0644 "$SOURCE_DIR/$unit" "/etc/systemd/system/$unit"
done
/usr/local/libexec/datool-log-discovery
/opt/fluent-bit/bin/fluent-bit --dry-run -c /etc/datool-logging/fluent-bit.conf
systemd-analyze verify /etc/systemd/system/datool-logging.service \
  /etc/systemd/system/datool-log-discovery.service /etc/systemd/system/datool-log-discovery.timer
systemctl daemon-reload
systemctl enable --now datool-logging.service datool-log-discovery.timer
systemctl is-active --quiet datool-logging.service
logger -t datool-logging-canary "datool-gcp-logging-installed $(date -u +%Y%m%dT%H%M%SZ)"
systemctl --no-pager status datool-logging.service
echo 'Collector started. Verify the canary and real nginx/container records in Cloud Logging before declaring success.'
