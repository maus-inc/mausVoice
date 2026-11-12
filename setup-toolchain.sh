#!/usr/bin/env bash
# Rebuild the offline Rust toolchain for the Arena sandbox.
#
# /tmp is wiped between turns, so every command that needs cargo has to run after
# this script in the same shell:
#
#   . ./setup-toolchain.sh && <cargo command>
#
# Sources: engineering/rust-toolchain.md and FETCH.md on the vendor/sandbox-toolchain
# branch. Nothing here needs a host outside the sandbox allowlist; the payload comes
# from the repository itself.
set -eu

# `set -e` does not fire inside an AND-OR list, and the documented invocation is
# `. ./setup-toolchain.sh && <cargo command>` -- so the whole script runs as the
# left side of `&&` and a failed step would not stop it. Every step that matters
# therefore reports its own failure, and the script says whether it is ready
# rather than letting the caller assume it.
#
# `return` only works when this file is sourced, and `exit` only when it is
# executed; the pair below does both. It has to be used at top level, not from
# inside a function, or `return` would leave the function instead of the script.
_fail() {
  echo "setup-toolchain: $1" >&2
}

SV=/tmp/vend
PREFIX=/tmp/rust-tools
# Private so the sandbox never writes into the developer's own Cargo state.
CARGO_HOME=/tmp/cargo-home
export CARGO_HOME
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -x "$PREFIX/bin/cargo" ]; then
  echo "== fetching the vendored payload ==" >&2
  mkdir -p "$SV"
  ( cd "$REPO" \
    && git fetch --depth=1 origin vendor/sandbox-toolchain >/dev/null 2>&1 \
    && git archive FETCH_HEAD rust system | tar -x -C "$SV" ) || {
    _fail "could not fetch the vendored payload from vendor/sandbox-toolchain"
    return 1 2>/dev/null || exit 1
  }

  echo "== installing rust 1.88.0 ==" >&2
  mkdir -p "$PREFIX"
  for t in "$SV"/rust/toolchain/*-1.88.0-*.tar.xz; do
    d=$(mktemp -d)
    tar xJf "$t" -C "$d" || {
      _fail "could not unpack $t"
      return 1 2>/dev/null || exit 1
    }
    "$d"/*/install.sh --prefix="$PREFIX" --disable-ldconfig >/dev/null || {
      _fail "could not install the 1.88.0 toolchain from $t"
      return 1 2>/dev/null || exit 1
    }
    rm -rf "$d"
  done

  echo "== cross-target standard libraries ==" >&2
  for t in x86_64-pc-windows-msvc aarch64-apple-darwin; do
    d=$(mktemp -d)
    tar xJf "$SV/rust/targets/$t/rust-std-1.88.0.tar.xz" -C "$d" || {
      _fail "could not unpack the $t standard library"
      return 1 2>/dev/null || exit 1
    }
    cp -r "$d"/rust-std-1.88.0-"$t"/rust-std-"$t"/lib/rustlib/"$t" "$PREFIX"/lib/rustlib/ || {
      _fail "could not install the $t standard library"
      return 1 2>/dev/null || exit 1
    }
    rm -rf "$d"
  done

  echo "== unpacking the cargo vendor tree ==" >&2
  cat "$SV"/rust/cargo-vendor.tar.xz.part-* > /tmp/cargo-vendor.tar.xz || {
    _fail "could not assemble the cargo vendor archive"
    return 1 2>/dev/null || exit 1
  }
  mkdir -p /tmp/cargo-vendor
  tar xJf /tmp/cargo-vendor.tar.xz -C /tmp/cargo-vendor || {
    _fail "could not unpack the cargo vendor tree"
    return 1 2>/dev/null || exit 1
  }
  rm -f /tmp/cargo-vendor.tar.xz
fi

# Cargo's config lives in a sandbox-private CARGO_HOME, not $HOME/.cargo.
# Writing $HOME/.cargo/config.toml would replace a developer's own file -- and the
# replacement points at /tmp/cargo-vendor, which does not outlive the sandbox, so
# every later Cargo command would fail against a config that had destroyed the
# working one. A separate home keeps the sandbox self-contained.
#
# Seeded outside the install guard: the toolchain may already be unpacked while
# this home is not, and a Cargo run without the vendor config goes to the network.
if [ ! -f "$CARGO_HOME/config.toml" ]; then
  mkdir -p "$CARGO_HOME"
  if [ -f "$SV/rust/cargo-config.toml" ]; then
    cp "$SV/rust/cargo-config.toml" "$CARGO_HOME/config.toml"
  else
    echo "cargo config missing at $SV/rust/cargo-config.toml" >&2
    exit 1
  fi
fi

if [ ! -d /tmp/sysroot/usr/include/gtk-3.0 ]; then
  echo "== joining the debian sysroot ==" >&2
  cat "$SV"/system/debian12-dev-sysroot.tar.xz.part-* > /tmp/sysroot.tar.xz || {
    _fail "could not assemble the sysroot archive"
    return 1 2>/dev/null || exit 1
  }
  mkdir -p /tmp/sysroot
  tar xJf /tmp/sysroot.tar.xz -C /tmp/sysroot || {
    _fail "could not unpack the debian sysroot"
    return 1 2>/dev/null || exit 1
  }
  rm -f /tmp/sysroot.tar.xz
fi

export PATH="$PREFIX/bin:$SV/system/tools/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib:/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CARGO_TARGET_DIR=/tmp/target
export CARGO_NET_OFFLINE=true
export PKG_CONFIG="$SV/system/tools/bin/pkg-config"
export PKG_CONFIG_SYSROOT_DIR=/tmp/sysroot
export PKG_CONFIG_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/sysroot/usr/share/pkgconfig
export LIBCLANG_PATH=/tmp/sysroot/usr/lib/llvm-14/lib

# Readiness is `cargo` actually answering, not the last command having run.
# Checked separately so a toolchain that unpacked but cannot execute is reported
# instead of announced as ready.
if ! cargo --version >/dev/null 2>&1; then
  _fail "cargo is not runnable after setup; PATH is $PATH"
  return 1 2>/dev/null || exit 1
fi

echo "toolchain ready: $(cargo --version)" >&2
