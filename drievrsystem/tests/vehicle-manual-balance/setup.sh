#!/usr/bin/env bash
# Manual vehicle balance suite — verifies explicit vehicle deposit/withdraw
# movements use the existing vehicle_ledger, stay isolated per vehicle, and do
# not alter receipt-row payment or company/Karta domains.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-vehicle-manual-balance"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT/entities.js" "$W/_src/entities.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
