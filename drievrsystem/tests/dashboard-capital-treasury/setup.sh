#!/usr/bin/env bash
# Dashboard Capital Treasury regression harness.
# Executes the real DB/repository path on the shared IndexedDB shim and
# evaluates source-extracted Dashboard functions against controlled DOM shims.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-dashboard-capital-treasury"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT"/{database.js,money.js,dashboard.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
