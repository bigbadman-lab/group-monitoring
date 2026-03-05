#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SYSTEMD="$REPO_ROOT/deploy/systemd"
DEST="/etc/systemd/system"

echo "Installing systemd units from $DEPLOY_SYSTEMD to $DEST"

install_if_exists() {
  local name="$1"
  if [[ -f "$DEPLOY_SYSTEMD/$name" ]]; then
    cp "$DEPLOY_SYSTEMD/$name" "$DEST/$name"
    echo "  installed: $name"
  else
    echo "  skipped (not found): $name"
  fi
}

install_if_exists "fb-groups-monitor.service"
install_if_exists "group-monitor-ingest.service"
install_if_exists "group-monitor-enrich.service"
install_if_exists "group-monitor-hourly-report.service"
install_if_exists "group-monitor-hourly-report.timer"

echo "Running systemctl daemon-reload..."
systemctl daemon-reload
echo "Done."
