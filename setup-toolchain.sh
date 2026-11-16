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

# Whether the toolchain is *complete*, not merely present. `cargo` on its own is
# not enough: an install that failed after the binaries landed leaves the
# cross-target standard libraries, the vendor tree and the sysroot missing, and a
# second run that saw `$PREFIX/bin/cargo` and skipped the whole block would then
# announce a toolchain that cannot build the workspace. Each piece below is
# checked where it is used, so a retry fills in whatever the last run did not.
# A directory existing is not the same as its extraction having finished: an
# interrupted `tar` leaves a partly-written tree that looks complete by name, and
# the next run would skip the step and report readiness over it. Each unpacked
# tree therefore gets a marker written only after `tar` succeeded, and the marker
# -- not the directory -- is what the retry check asks for.
toolchain_installed() {
  [ -x "$PREFIX/bin/cargo" ] &&
    [ -f "$PREFIX/.install-complete" ] &&
    [ -f /tmp/cargo-vendor/.unpack-complete ] &&
    [ -f /tmp/sysroot/.unpack-complete ] &&
    [ -f "$CARGO_HOME/config.toml" ] &&
    # The payload itself belongs in this list. Every other check reads something
    # the payload produced, so with /tmp/vend gone and the outputs intact, setup
    # would skip the fetch and then fail on the missing source -- and no later run
    # would refetch it, so the failure repeated until the payload came back.
    [ -f "$SV/rust/cargo-config.toml" ] &&
    [ -d "$SV/rust/toolchain" ] &&
    # The native payloads, for the same reason as the cargo config: a run that
    # installed the toolchain but not these would report ready and then send the
    # two transcription `build.rs` scripts to a blocked host.
    [ -d "$SV/native" ]
}

if ! toolchain_installed; then
  echo "== fetching the vendored payload ==" >&2
  mkdir -p "$SV"
  ( cd "$REPO" \
    && git fetch --depth=1 origin vendor/sandbox-toolchain >/dev/null 2>&1 \
    && git archive FETCH_HEAD rust system native | tar -x -C "$SV" ) || {
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

  # The binaries, the cross-target libraries and the marker that says both landed
  # are written by the loop above and the loop before it, so the marker after them
  # is what makes a partial install visible to the retry check.
  : > "$PREFIX/.install-complete"

  echo "== unpacking the cargo vendor tree ==" >&2
  cat "$SV"/rust/cargo-vendor.tar.xz.part-* > /tmp/cargo-vendor.tar.xz || {
    _fail "could not assemble the cargo vendor archive"
    return 1 2>/dev/null || exit 1
  }
  rm -rf /tmp/cargo-vendor
  mkdir -p /tmp/cargo-vendor
  tar xJf /tmp/cargo-vendor.tar.xz -C /tmp/cargo-vendor || {
    _fail "could not unpack the cargo vendor tree"
    return 1 2>/dev/null || exit 1
  }
  rm -f /tmp/cargo-vendor.tar.xz
  : > /tmp/cargo-vendor/.unpack-complete
fi

# Cargo's config lives in a sandbox-private CARGO_HOME, not $HOME/.cargo.
# Writing $HOME/.cargo/config.toml would replace a developer's own file -- and the
# replacement points at /tmp/cargo-vendor, which does not outlive the sandbox, so
# every later Cargo command would fail against a config that had destroyed the
# working one. A separate home keeps the sandbox self-contained.
#
# Seeded outside the install guard: the toolchain may already be unpacked while
# this home is not, and a Cargo run without the vendor config goes to the network.
# Compared against the payload rather than merely checked for existence: a file
# that is present but not the payload is exactly what a copy interrupted by a full
# disk leaves behind, and skipping on "it exists" would carry that forward forever.
config_is_current() {
  [ -f "$CARGO_HOME/config.toml" ] &&
    [ -f "$SV/rust/cargo-config.toml" ] &&
    cmp -s "$SV/rust/cargo-config.toml" "$CARGO_HOME/config.toml"
}

if ! config_is_current; then
  mkdir -p "$CARGO_HOME" || {
    _fail "could not create $CARGO_HOME"
    return 1 2>/dev/null || exit 1
  }
  if [ -f "$SV/rust/cargo-config.toml" ]; then
    # Checked because an unguarded failure here reports readiness without the
    # vendor config, and every later Cargo command then goes to the network.
    # Staged and renamed: a copy that fails halfway leaves a truncated file that
    # the existence check above would accept on the next run, and Cargo would then
    # read a config that parses to nothing.
    cp "$SV/rust/cargo-config.toml" "$CARGO_HOME/config.toml.tmp" || {
      _fail "could not stage the cargo config in $CARGO_HOME"
      return 1 2>/dev/null || exit 1
    }
    mv "$CARGO_HOME/config.toml.tmp" "$CARGO_HOME/config.toml" || {
      _fail "could not install the cargo config into $CARGO_HOME"
      return 1 2>/dev/null || exit 1
    }
  else
    _fail "cargo config missing at $SV/rust/cargo-config.toml"
    return 1 2>/dev/null || exit 1
  fi
fi

if [ ! -f /tmp/sysroot/.unpack-complete ]; then
  echo "== joining the debian sysroot ==" >&2
  cat "$SV"/system/debian12-dev-sysroot.tar.xz.part-* > /tmp/sysroot.tar.xz || {
    _fail "could not assemble the sysroot archive"
    return 1 2>/dev/null || exit 1
  }
  # Staged, then published: an interrupted extraction must not leave a tree that
  # satisfies the check above, or the next run skips the step and reports a
  # sysroot that is missing whatever the interrupted `tar` had not reached yet.
  rm -rf /tmp/sysroot.staging
  mkdir -p /tmp/sysroot.staging
  tar xJf /tmp/sysroot.tar.xz -C /tmp/sysroot.staging || {
    _fail "could not unpack the debian sysroot"
    return 1 2>/dev/null || exit 1
  }
  rm -f /tmp/sysroot.tar.xz
  rm -rf /tmp/sysroot
  mv /tmp/sysroot.staging /tmp/sysroot || {
    _fail "could not publish the debian sysroot"
    return 1 2>/dev/null || exit 1
  }
  : > /tmp/sysroot/.unpack-complete
fi

# The ONNX Runtime library, unpacked from the payload archive. Its `build.rs`
# would download this from a GitHub Release the sandbox cannot reach, and it wants
# a path to the library file rather than to the archive, so the `.tgz` is opened
# here. Staged and published with a marker, for the same reason as the sysroot: a
# half-written tree must not satisfy the retry check.
if [ ! -f /tmp/ort/.unpack-complete ]; then
  echo "== unpacking onnxruntime ==" >&2
  rm -rf /tmp/ort.staging
  mkdir -p /tmp/ort.staging
  tar xzf "$SV"/native/onnxruntime/onnxruntime-linux-x64-*.tgz -C /tmp/ort.staging || {
    _fail "could not unpack the onnxruntime archive"
    return 1 2>/dev/null || exit 1
  }
  rm -rf /tmp/ort
  mv /tmp/ort.staging /tmp/ort || {
    _fail "could not publish the onnxruntime tree"
    return 1 2>/dev/null || exit 1
  }
  : > /tmp/ort/.unpack-complete
fi

export PATH="$PREFIX/bin:$SV/system/tools/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib:/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CARGO_TARGET_DIR=/tmp/target
export CARGO_NET_OFFLINE=true
export PKG_CONFIG="$SV/system/tools/bin/pkg-config"
export PKG_CONFIG_SYSROOT_DIR=/tmp/sysroot
export PKG_CONFIG_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/tmp/sysroot/usr/share/pkgconfig
export LIBCLANG_PATH=/tmp/sysroot/usr/lib/llvm-14/lib

# The two native archives the transcription `build.rs` scripts would otherwise
# download from GitHub Releases, which the sandbox cannot reach. Pointing at the
# payload keeps both builds offline. `MAUSVOICE_ORT_DYLIB_PATH` is a file, and the
# archive's `.so` is a symlink, so the check follows it. `SHERPA_ONNX_ARCHIVE_DIR`
# is the directory holding the archive, so `build.rs` still verifies its digest.
export MAUSVOICE_ORT_DYLIB_PATH="$(find /tmp/ort -name libonnxruntime.so | head -1)"
[ -f "$MAUSVOICE_ORT_DYLIB_PATH" ] || {
  _fail "onnxruntime library not found under /tmp/ort"
  return 1 2>/dev/null || exit 1
}
export SHERPA_ONNX_ARCHIVE_DIR="$SV/native/sherpa-onnx"

# Readiness is `cargo` actually answering, not the last command having run.
# Checked separately so a toolchain that unpacked but cannot execute is reported
# instead of announced as ready.
if ! cargo --version >/dev/null 2>&1; then
  _fail "cargo is not runnable after setup; PATH is $PATH"
  return 1 2>/dev/null || exit 1
fi

echo "toolchain ready: $(cargo --version)" >&2
