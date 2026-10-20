#!/usr/bin/env bash
# Read-only active vehicle-ledger business-date integrity diagnostic suite.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-vehicle-ledger-date-integrity"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT"/{database.js,dateUtils.js} "$W/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT/services/ledgerIntegrityDiagnostics.js" "$W/services/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
