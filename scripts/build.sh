#!/usr/bin/env bash
# Builds dist/inboxbroom-firefox.xpi (MV2) and dist/inboxbroom-chrome.zip + dist/chrome/ (MV3, "Load unpacked").
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/chrome
FILES=(background.js content.js content.css lib popup options review ui icons)
# Firefox
zip -qr dist/inboxbroom-firefox.xpi manifest.json "${FILES[@]}"
# Chromium
cp -r "${FILES[@]}" background.sw.js dist/chrome/
cp manifest.chrome.json dist/chrome/manifest.json
(cd dist/chrome && zip -qr ../inboxbroom-chrome.zip .)
ls -la dist/*.xpi dist/*.zip
