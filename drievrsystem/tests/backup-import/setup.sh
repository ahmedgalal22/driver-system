#!/usr/bin/env bash
# Backup/import contract suite — runs on an isolated temporary IndexedDB shim.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-backup-import"
rm -rf "$W"; mkdir -p "$W/services"
cp "$ROOT/database.js" "$W/"
cp "$ROOT/tests/write-path/idb-shim.mjs" "$W/"
cp "$ROOT/services/backupService.js" "$W/services/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
