#!/usr/bin/env bash
# Driver Details Cards date-range filter regression — source-extracted UI logic.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-driver-karta-date-filter"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT"/{entities.js,financial.js,index.html,styles.css} "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
