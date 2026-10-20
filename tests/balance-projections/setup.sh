#!/usr/bin/env bash
# Balance projection suite — verifies that existing receipt-row-payment ledger
# effects are read into the vehicle/customer and company balance projections.
# It runs real production financial modules on the shared IndexedDB shim.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-balance-projections"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT"/{entities.js,offices.js} "$W/_src/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
