#!/usr/bin/env bash
# All Receipts driver-name filter regression.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-all-receipts-driver-filter"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT/allReceipts.js" "$W/allReceipts.src.js"
mkdir -p "$W/services"
cp "$ROOT/services/financialCalculator.js" "$W/services/"
cp "$ROOT/money.js" "$W/"
printf '{"type":"module"}\n' > "$W/package.json"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
