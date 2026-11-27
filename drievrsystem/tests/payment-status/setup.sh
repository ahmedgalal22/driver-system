#!/usr/bin/env bash
# Payment Status (الحالة) suite — verifies the per-receipt-row payment state
# machine: لم يتم صرفه ⇄ تم صرفه on every All-Receipts row, with the financial
# posting contract (vehicle leg = الصافي; company leg = الصافي + الصرف)
# created/reversed EXACTLY ONCE per transition, in ONE atomic transaction,
# keyed by the receipt row UUID (reference_id = row_id).
# Runs REAL production modules on the idb shim; browser-coupled snapshot/print
# functions are executed as verbatim-extracted source — never imported whole.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-payment-status"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$(dirname "${BASH_SOURCE[0]}")/../write-path/idb-shim.mjs" "$W/"
# Production sources read as TEXT for verbatim extraction + fingerprints/census
cp "$ROOT"/receipts.js "$W/_src/receipts.js"
cp "$ROOT"/allReceipts.js "$W/_src/allReceipts.js"
cp "$ROOT"/excelService.js "$W/_src/excelService.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
