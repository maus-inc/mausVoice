#!/usr/bin/env bash
set -euo pipefail

# Regenerates bindings.ts and fails if it differs from the committed file.
# Catches silent reintroduction of dead specta scaffolding (or any exporter drift).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

TARGET="packages/desktop-native-apis/src/bindings.ts"

# Ensure the file is tracked and has no local changes before regenerating, so we
# never overwrite a developer's in-progress work.
if ! git ls-files --error-unmatched "$TARGET" >/dev/null 2>&1; then
  echo "ERROR: $TARGET is not tracked by git." >&2
  exit 1
fi
if ! git diff --quiet -- "$TARGET" || ! git diff --cached --quiet -- "$TARGET"; then
  echo "ERROR: $TARGET has local changes. Commit or stash them before checking bindings." >&2
  exit 1
fi

# Regenerate (includes the post-process transform in bindings.sh).
bash scripts/bindings.sh

if ! git diff --quiet -- "$TARGET"; then
  echo "ERROR: regenerating bindings.ts produced a diff. Commit the result or fix scripts/bindings.sh." >&2
  git --no-pager diff --stat -- "$TARGET"
  exit 1
fi

echo "bindings.ts is consistent with the generator output."
