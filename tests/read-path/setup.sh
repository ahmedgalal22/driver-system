#!/usr/bin/env bash
# Read-path end-to-end harness (Phase 4 — Step 7 evidence).
# Assembles the intended services/+constants/ layout from the flat repo into a
# temp dir, then verifies the migrated UI read paths (dashboard.js / offices.js)
# against the REAL frozen read stack + REAL persisted data written through the
# REAL frozen write path. Re-runs the write-path harness afterwards as a
# frozen-baseline regression gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-read-path"
rm -rf "$W"; mkdir -p "$W/services" "$W/constants"

# Real production modules (same layout contract as tests/write-path)
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/{dbProvider.js,writeDataSource.js,readDataSource.js,persistenceCommand.js,receiptRepository.js,receiptReadRepository.js,clientRepository.js,officeRepository.js,treasuryRepository.js,dashboardRepository.js,authRepository.js,driverKartaReadRepository.js,financialCalculator.js} "$W/services/"
cp "$ROOT"/payoutStatus.js "$W/constants/"

# Real modified UI sources — read as TEXT for static assertions (never imported:
# they carry browser-only dependencies)
cp "$ROOT"/dashboard.js "$W/dashboard.src.js"
cp "$ROOT"/offices.js  "$W/offices.src.js"

# Shared IndexedDB shim from the write-path harness (single source of truth)
cp "$(dirname "${BASH_SOURCE[0]}")"/../write-path/idb-shim.mjs "$W/"
cp "$(dirname "${BASH_SOURCE[0]}")"/run.mjs "$W/"

# ── Repo-wide census gate: ZERO executable embedded-rows accessors ──────────
echo '— Census gate: embedded receipt.rows accessors repo-wide —'
if grep -nE 'Array\.isArray\(\s*(receipt|r)\.rows' "$ROOT"/*.js; then
  echo '❌ CENSUS FAIL: executable embedded receipt.rows accessor found'
  exit 1
fi
echo 'PASS  no Array.isArray(receipt.rows|Array.isArray(r.rows accessors anywhere in repo root js'

cd "$W" && node run.mjs

echo
echo '═══ Frozen-baseline regression: re-running write-path harness ═══'
bash "$ROOT/tests/write-path/setup.sh"
