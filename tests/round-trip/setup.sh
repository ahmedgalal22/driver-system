#!/usr/bin/env bash
# Round-trip DIAGNOSTIC harness (investigation only — no fix).
# Verifies Create → Persist → Read → All Forms → Edit → Reconstruct for one
# fully-populated Receipt using the REAL production modules on the idb shim,
# plus the REAL bridge/mapping functions extracted verbatim from the
# production sources (receipts.js / allReceipts.js are browser-coupled, so
# they are executed as extracted function source — never imported whole).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-round-trip"
rm -rf "$W"; mkdir -p "$W/services" "$W/constants" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT"/constants/payoutStatus.js "$W/constants/"
cp "$(dirname "${BASH_SOURCE[0]}")"/../write-path/idb-shim.mjs "$W/"
# Production sources read as TEXT for real function extraction + fingerprints
cp "$ROOT"/receipts.js "$W/_src/receipts.js"
cp "$ROOT"/allReceipts.js "$W/_src/allReceipts.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
