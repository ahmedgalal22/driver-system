#!/usr/bin/env bash
# Read-only historical Driver Deposit integrity diagnostic suite.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-driver-deposit-integrity"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
