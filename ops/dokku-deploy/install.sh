#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test "$(id -u)" = 0
test "$#" = 1
python3 - "$1" <<'PY'
from pathlib import Path
import re
import sys
if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [^\r\n]+)?", Path(sys.argv[1]).read_text().strip()):
    raise SystemExit("Expected one plain Ed25519 public key")
PY
if ! id datool-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh datool-deploy
fi
test "$(id -Gn datool-deploy)" = datool-deploy
usermod --lock datool-deploy
chown root:root /home/datool-deploy
chmod 0755 /home/datool-deploy
install -d -o root -g root -m 0755 /home/datool-deploy/.ssh /usr/local/lib/datool-deploy
install -o root -g root -m 0755 deploy-command /usr/local/lib/datool-deploy/deploy-command
visudo -cf deploy.sudoers
install -o root -g root -m 0440 deploy.sudoers /etc/sudoers.d/datool-deploy
{
  printf 'restrict,command="/usr/local/lib/datool-deploy/deploy-command" '
  cat "$1"
  printf '\n'
} > /home/datool-deploy/.ssh/authorized_keys
chown root:root /home/datool-deploy/.ssh/authorized_keys
chmod 0644 /home/datool-deploy/.ssh/authorized_keys
visudo -c
ssh-keygen -lf "$1"
