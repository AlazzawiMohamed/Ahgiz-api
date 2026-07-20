#!/usr/bin/env bash
# verify-index.sh — check that every file path mentioned in INDEX.md exists.
# Lists any stale paths and exits non-zero. Deps: bash + grep only.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$ROOT/INDEX.md"
[ -f "$INDEX" ] || { echo "verify-index: INDEX.md not found at $INDEX"; exit 2; }

# Backticked tokens that look like repo files: end in a known extension.
# URL prefixes (e.g. /admin/dashboard) have no extension and are ignored.
paths="$(grep -oE '`[^`]+\.(js|ts|tsx|sql|json|sh|md|css|mjs)`' "$INDEX" | tr -d '\140' | sort -u)"

missing=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ ! -e "$ROOT/$p" ]; then
    echo "STALE: $p"
    missing=1
  fi
done <<EOF
$paths
EOF

if [ "$missing" -ne 0 ]; then
  echo "verify-index: stale paths found — update INDEX.md"
  exit 1
fi
echo "verify-index: OK — every path in INDEX.md exists"
