#!/usr/bin/env bash
# Office Details boot-state regression suite.
# Runs the REAL app.js boot code with the REAL offices.js resolver and real
# IndexedDB implementation/shim. Browser-only modules unrelated to boot-state
# restoration are minimal stubs so each scenario can execute in Node.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-office-details-boot"
rm -rf "$W"
mkdir -p "$W/services"

# Production modules exercised by the boot restore and Office Details resolver.
cp "$ROOT"/{app.js,database.js,financial.js,offices.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/services/*.js "$W/services/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"

# Browser-only modules not relevant to this focused boot test. app.js itself is
# copied verbatim above; these simply keep unrelated page initializers inert.
cat > "$W/auth.js" <<'EOF'
export const AuthModule = Object.freeze({
  getSession: () => globalThis.__OFFICE_BOOT_SESSION__ || null,
  logout: () => {},
});
EOF
cat > "$W/receipts.js" <<'EOF'
export function initReceiptPage() {}
EOF
cat > "$W/allReceipts.js" <<'EOF'
export async function initAllReceiptsPage() {}
EOF
cat > "$W/entities.js" <<'EOF'
export function attachOwnersPageListeners() {}
export async function loadOwners() {}
EOF
cat > "$W/home.js" <<'EOF'
export function initHomePage() {}
EOF
cat > "$W/sidebarLayout.js" <<'EOF'
export function initSidebarLayout() {}
EOF
cat > "$W/dashboard.js" <<'EOF'
export async function initDashboardPage() {}
EOF
cat > "$W/loadPrices.js" <<'EOF'
export function initLoadPricesPage() {}
export async function loadLoadPrices() {}
EOF

cd "$W"
node run.mjs
