#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test "$(id -u)" = 0
install -d -m 0755 /usr/local/lib/datool-disk /var/lib/dokku/plugins/available/disk
install -d -o dokku -g dokku -m 0750 /var/lib/dokku/data/datool-disk-maintenance
install -m 0755 maintenance.py /usr/local/lib/datool-disk/maintenance.py
install -m 0755 commands /var/lib/dokku/plugins/available/disk/commands
install -m 0644 plugin.toml /var/lib/dokku/plugins/available/disk/plugin.toml
ln -sfn /var/lib/dokku/plugins/available/disk /var/lib/dokku/plugins/enabled/disk
install -m 0644 datool-disk-maintenance.service datool-disk-maintenance.timer /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/docker-builder-prune.service.d
install -m 0644 builder-cache-retention.conf /etc/systemd/system/docker-builder-prune.service.d/retention.conf
systemctl daemon-reload
dokku disk:cleanup datool
systemctl enable --now datool-disk-maintenance.timer docker-builder-prune.timer
