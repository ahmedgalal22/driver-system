#!/usr/bin/env bash
# Receipt-row company charge suite — verifies one independent company-only
# withdrawal per receipt row, atomic lifecycle reversal, and payment-status
# independence using real production FinancialService on the IndexedDB shim.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-receipt-row-company-charge"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
