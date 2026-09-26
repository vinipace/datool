#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test "$(id -u)" = 0
test "$#" = 1
test -f /usr/local/lib/datool-disk/maintenance.py
# Accept only one plain public key, never supplied authorized_keys options.
python3 - "$1" <<'PY'
from pathlib import Path
import re
import sys
key = Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\r\n]+)?", key):
    raise SystemExit("Expected one plain Ed25519 public key")
PY
ssh-keygen -lf "$1"
if ! id datool-monitor >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh datool-monitor
fi
test "$(id -Gn datool-monitor)" = datool-monitor
usermod --lock datool-monitor
chown root:root /home/datool-monitor
chmod 0755 /home/datool-monitor
install -d -o root -g root -m 0755 /home/datool-monitor/.ssh
install -m 0755 monitor-command /usr/local/lib/datool-disk/monitor-command
visudo -cf monitor.sudoers
install -o root -g root -m 0440 monitor.sudoers /etc/sudoers.d/datool-monitor
{
  printf 'restrict,command="/usr/local/lib/datool-disk/monitor-command" '
  cat "$1"
  printf '\n'
} > /home/datool-monitor/.ssh/authorized_keys
chown root:root /home/datool-monitor/.ssh/authorized_keys
chmod 0644 /home/datool-monitor/.ssh/authorized_keys
visudo -c
