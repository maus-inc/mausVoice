#!/usr/bin/env bash
#
# Lint, test and build-check the native pill crates plus the packaged app icons.
#
# Why this exists
# ---------------
# The three pill crates (`packages/rust_{windows,macos,gtk}_pill`) are separate
# Cargo workspaces. The desktop lint job only runs clippy against
# `apps/desktop/src-tauri`, so nothing checked the pill crates — and
# `prepare-sidecars.mjs` treats a failed pill build as a warning. A crate could
# therefore stop compiling while CI stayed green, and the app would silently
# ship a stale pill binary. That is exactly what happened: the Windows pill had
# a `&Gfx` / `&mut Gfx` type error, so none of the pill changes reached users.
#
# Run this for the current host platform before releasing:
#
#   ./scripts/verify-native-pills.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failed=0

step() {
  echo ""
  echo "==> $*"
}

# Pick the crate that can actually build on this host. Each pill binds to
# platform-specific APIs (Direct2D, Core Graphics, GTK/Cairo), so only the
# matching one is checked here; CI covers the others on their own runners.
case "$(uname -s)" in
  Darwin) crate="rust_macos_pill" ;;
  Linux) crate="rust_gtk_pill" ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) crate="rust_windows_pill" ;;
  *)
    echo "Unrecognised platform $(uname -s); skipping pill checks." >&2
    crate=""
    ;;
esac

if [[ -n "$crate" ]]; then
  if command -v cargo >/dev/null 2>&1; then
    manifest="packages/$crate/Cargo.toml"

    step "clippy: $crate"
    if ! cargo clippy --manifest-path "$manifest" --all-targets -- -D warnings; then
      echo "FAIL: clippy reported problems in $crate" >&2
      failed=1
    fi

    step "tests: $crate"
    if ! cargo test --manifest-path "$manifest"; then
      echo "FAIL: unit tests failed in $crate" >&2
      failed=1
    fi
  else
    echo "cargo not found; cannot verify $crate." >&2
    failed=1
  fi
fi

step "app icons"
if ! node scripts/generate-app-icons.mjs --check; then
  echo "FAIL: app icons are missing frames or have lost their alpha" >&2
  failed=1
fi

echo ""
if [[ "$failed" -ne 0 ]]; then
  echo "Native pill verification FAILED."
  exit 1
fi
echo "Native pill verification passed."
