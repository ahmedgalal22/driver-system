#!/usr/bin/env bash
# Vehicle Details responsive-layout contract — static source only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-vehicle-details-responsive-layout"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT"/{entities.js,styles.css} "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
