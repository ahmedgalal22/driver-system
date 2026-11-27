#!/usr/bin/env bash
# Real services and IndexedDB shim with a minimal DOM double; not browser E2E.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-office-list"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT"/{database.js,financial.js,offices.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/receipts.js" "$W/receipts.src.js"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cat > "$W/auth.js" <<'STUB'
export const AuthModule = { getSession: () => ({ username: 'office-list-user' }) };
STUB
cd "$W" && node run.mjs
