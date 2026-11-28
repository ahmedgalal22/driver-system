#!/usr/bin/env bash
# Real authentication and database modules with an IndexedDB shim and DOM doubles.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-admin-only-auth"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,auth.js,dateUtils.js} "$W/"
cp "$ROOT/services/"{authRepository.js,dbProvider.js} "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT"/{app.js,dashboard.js,login.html} "$W/_src/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
