#!/usr/bin/env bash
# Installs user-level systemd units that start Ollama on the first request to localhost:11434
# and stop it again a few minutes after the last one. No root needed. Linux + systemd only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.config/systemd/user"
command -v curl >/dev/null || { echo "curl not found; the on-demand unit uses it to wait for startup."; exit 1; }
command -v ollama >/dev/null || { echo "ollama not found in PATH. Install it first: https://ollama.com"; exit 1; }
[ -x /usr/lib/systemd/systemd-socket-proxyd ] || { echo "systemd-socket-proxyd not found (part of systemd)."; exit 1; }
if systemctl is-active --quiet ollama 2>/dev/null; then
  echo "A system-wide ollama.service is running on :11434. Stop/disable it first:"
  echo "  sudo systemctl disable --now ollama"
  exit 1
fi
mkdir -p "$dest"
cp "$here"/ollama-proxy.socket "$here"/ollama-proxy.service "$dest"/
# put the detected binary first in the unit's search list (/usr/bin from distro packages, /usr/local/bin from the official installer)
sed "s|@OLLAMA@|$(command -v ollama)|" "$here"/ollama.service > "$dest"/ollama.service
systemctl --user daemon-reload
systemctl --user enable --now ollama-proxy.socket
echo "Installed. First request to http://127.0.0.1:11434 starts Ollama; it stops 3 min after the last one."
echo "Check:  curl -s http://127.0.0.1:11434/api/version && systemctl --user status ollama.service"
