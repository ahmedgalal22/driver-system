#!/usr/bin/env bash
# Vehicle Details UI regression — source-level and renderer checks only.
# Keeps the financial model out of scope while pinning the redesigned page's
# functional actions, movement fields, empty state, and scoped styles.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-vehicle-details-ui"
rm -rf "$W"; mkdir -p "$W"
cp "$ROOT/entities.js" "$W/entities.src.js"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
