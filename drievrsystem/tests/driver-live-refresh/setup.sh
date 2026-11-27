#!/usr/bin/env bash
# Driver live-refresh regression harness. Exercises the real browser-coupled
# receipt helpers as verbatim source with a focused DOM double.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-driver-live-refresh"
rm -rf "$W"; mkdir -p "$W/_src"
cp "$ROOT/receipts.js" "$W/_src/receipts.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
