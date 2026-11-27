#!/usr/bin/env bash
# Driver Details presentation regression harness. Exercises the real renderer
# helpers as verbatim source with a small DOM double; no persistence writes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="${TMPDIR:-/tmp}/wpt-driver-details-presentation"
rm -rf "$W"; mkdir -p "$W/_src"
cp "$ROOT"/{entities.js,index.html,styles.css} "$W/_src/"
cp "$(dirname "${BASH_SOURCE[0]}")/run.mjs" "$W/"
cd "$W" && node run.mjs
