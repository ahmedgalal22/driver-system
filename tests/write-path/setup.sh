#!/usr/bin/env bash
# Write-path end-to-end harness (Phase 4, blockers B1-B5 evidence).
# Assembles the intended services/+constants/ layout from the flat repo into a
# temp dir, then runs the REAL production modules (database.js, repositories,
# WriteDataSource, FinancialService) against a faithful IndexedDB shim.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-write-path"
rm -rf "$W"; mkdir -p "$W/services" "$W/constants"
cp "$ROOT"/{database.js,financial.js,money.js,dateUtils.js} "$W/"
cp "$ROOT"/{dbProvider.js,writeDataSource.js,readDataSource.js,persistenceCommand.js,receiptRepository.js,receiptReadRepository.js,clientRepository.js,officeRepository.js,treasuryRepository.js,dashboardRepository.js,authRepository.js,driverKartaReadRepository.js} "$W/services/"
cp "$ROOT"/payoutStatus.js "$W/constants/"
cp "$(dirname "${BASH_SOURCE[0]}")"/{idb-shim.mjs,run.mjs} "$W/"
cd "$W" && node run.mjs
