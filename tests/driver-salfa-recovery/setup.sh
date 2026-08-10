#!/usr/bin/env bash
# Driver Salfa Recovery suite — verifies recovery is a separate deposit-side
# driver ledger event that offsets salfa without touching receipt, vehicle,
# company, or Karta domains.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-driver-salfa-recovery"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js,index.html} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT/entities.js" "$W/_src/entities.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
