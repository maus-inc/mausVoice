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

SV=/tmp/vend
PREFIX=/tmp/rust-tools
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -x "$PREFIX/bin/cargo" ]; then
  echo "== fetching the vendored payload ==" >&2
  mkdir -p "$SV"
  ( cd "$REPO" \
    && git fetch --depth=1 origin vendor/sandbox-toolchain >/dev/null 2>&1 \
    && git archive FETCH_HEAD rust system | tar -x -C "$SV" )

  echo "== installing rust 1.88.0 ==" >&2
  mkdir -p "$PREFIX"
  for t in "$SV"/rust/toolchain/*-1.88.0-*.tar.xz; do
    d=$(mktemp -d)
    tar xJf "$t" -C "$d"
    "$d"/*/install.sh --prefix="$PREFIX" --disable-ldconfig >/dev/null
    rm -rf "$d"
  done

  echo "== cross-target standard libraries ==" >&2
  for t in x86_64-pc-windows-msvc aarch64-apple-darwin; do
    d=$(mktemp -d)
    tar xJf "$SV/rust/targets/$t/rust-std-1.88.0.tar.xz" -C "$d"
    cp -r "$d"/rust-std-1.88.0-"$t"/rust-std-"$t"/lib/rustlib/"$t" "$PREFIX"/lib/rustlib/
    rm -rf "$d"
  done

  echo "== unpacking the cargo vendor tree ==" >&2
  cat "$SV"/rust/cargo-vendor.tar.xz.part-* > /tmp/cargo-vendor.tar.xz
  mkdir -p /tmp/cargo-vendor
  tar xJf /tmp/cargo-vendor.tar.xz -C /tmp/cargo-vendor
  rm -f /tmp/cargo-vendor.tar.xz
  mkdir -p "$HOME/.cargo"
  cp "$SV/rust/cargo-config.toml" "$HOME/.cargo/config.toml"
fi

if [ ! -d /tmp/sysroot/usr/include/gtk-3.0 ]; then
  echo "== joining the debian sysroot ==" >&2
  cat "$SV"/system/debian12-dev-sysroot.tar.xz.part-* > /tmp/sysroot.tar.xz
  mkdir -p /tmp/sysroot
  tar xJf /tmp/sysroot.tar.xz -C /tmp/sysroot
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

echo "toolchain ready: $(cargo --version)" >&2
