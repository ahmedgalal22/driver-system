#!/usr/bin/env bash
# All Receipts summary regression — verifies row-derived net/sarf totals use
# the same loaded receipt-row projection and filter convention as existing cards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-all-receipts-summary"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT/allReceipts.js" "$W/allReceipts.src.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
