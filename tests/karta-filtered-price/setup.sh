#!/usr/bin/env bash
# Driver Karta filtered total-price regression.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-karta-filtered-price"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT/entities.js" "$W/entities.src.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
