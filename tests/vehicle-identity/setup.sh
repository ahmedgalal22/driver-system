#!/usr/bin/env bash
# Vehicle Identity suite — verifies the number-only vehicle identity contract:
# رقم المركبة → vehicle → owner (vehicle name field permanently removed).
# Runs REAL production modules on the idb shim; browser-coupled functions are
# executed as verbatim-extracted source — never imported whole.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-vehicle-identity"
rm -rf "$W"; mkdir -p "$W/services" "$W/_src"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$(dirname "${BASH_SOURCE[0]}")"/../write-path/idb-shim.mjs "$W/"
# Production sources read as TEXT for verbatim extraction + fingerprints/census
cp "$ROOT"/entities.js "$W/_src/entities.js"
cp "$ROOT"/receipts.js "$W/_src/receipts.js"
cp "$ROOT"/excelService.js "$W/_src/excelService.js"
cp "$ROOT"/index.html "$W/_src/index.html"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
