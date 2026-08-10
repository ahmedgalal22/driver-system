#!/usr/bin/env bash
# Manual Office Balance suite — verifies explicit company deposit/withdraw
# movements use existing vehicle_ledger, remain isolated per office, and stay
# separate from receipt-row payments and vehicle balances.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-office-manual-balance"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT/offices.js" "$W/_src/offices.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
