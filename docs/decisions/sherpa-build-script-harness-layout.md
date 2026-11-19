# The sherpa build-script harness must not assume cargo's build directory layout

Date: 2026-11-18
Status: accepted

## Context

`scripts/ci/sherpa-build-script-tests.mjs` compiles and runs the `#[cfg(test)] mod
tests` in `patches/sherpa-onnx-sys-1.13.5/build.rs`, which no other cargo command
in the repository builds. On 2026-11-18 the `Test Rust Transcription` job failed on
Ubuntu and Windows in the step `Test the sherpa-onnx-sys build script` with

```
expected exactly one sherpa-onnx-sys build script under .../target/debug/build
(looked for build-script-build), found 0
```

The failure was not caused by the change under test. The base branch failed the
same step, the harness and `build.rs` were byte-identical to the last green commit
`b1acb431`, and the only variable was the runner toolchain. The last green run on
2026-11-11 used rustc 1.99.1. The failing runs used rustc 1.100.0.

The harness probe build copies the patch crate into a temp directory and runs
`cargo build -vv` there. rustup resolves a toolchain from the manifest directory or
its ancestors, so the copy never saw the repository's `rust-toolchain.toml` and the
probe compiled with the runner's default stable rather than the pinned 1.88.0. The
pinned 1.88.0 a real build uses still writes `build/<pkg>-<hash>/build-script-build`.
Cargo 1.100.0 renamed and moved the file to
`build/<pkg>/<hash>/out/build_script_build`. The harness looked for the old name at
the old path, so it found nothing and refused to pass.

Reproduced locally with both toolchains from `rust-toolchain.toml` and the current
stable. Under 1.88.0 the harness passed 18/18; under 1.100.0 it failed with the CI
message. `target/debug/build/sherpa-onnx-sys/` under 1.100.0 holds only
`<hash>/out/build_script_build`, and cargo's own `Running` line for the build script
prints that path.

## Decision

Two independent fixes, each sufficient on its own, both kept because they defend
against different drifts.

1. The probe crate gets a copy of `rust-toolchain.toml`, so rustup resolves the
   pinned channel for the probe exactly as it does for the rest of the repository.
   This is the root cause. The probe was compiling with a compiler the project does
   not build with.

2. The build-script lookup walks the package's own subtree and accepts both cargo
   spellings, `build-script-build` and `build_script_build`, at any depth. It no
   longer hard-codes the pre-1.100 path. The walk is confined to a directory named
   `sherpa-onnx-sys` or `sherpa-onnx-sys-<hash>`, so a dependency's build script,
   which is also named `build_script_build`, cannot be mistaken for this one. A
   different crate whose name merely starts with `sherpa-onnx-sys` cannot be
   mistaken for it either. The "exactly one or refuse" contract is unchanged.

The harness does not pin a cargo version by string. The toolchain belongs in
`rust-toolchain.toml`, which the repository already owns, and a second copy of the
pin would drift from it. The harness also does not make the lookup tolerant of zero
matches. It exists to refuse when it cannot inspect the artifact, so a layout it
does not recognise has to fail loudly rather than pass quietly.

The toolchain copy means rustup may install the pinned channel on first use. That
install is a network fetch the harness's `offline` attempt flag does not govern,
because the flag adds `cargo build --offline`, which restricts cargo's registry and
not rustup's toolchain install. In CI the channel is already installed before the
harness runs, so the copy is a no-op there. A machine that has never built the
repository pays the one-time install, which every cargo command in the repository
pays too.

## Consequences

The step no longer breaks when the runner's default stable moves ahead of the
pinned toolchain, which is what happened here. The cost is that the harness now
carries two spellings of cargo's build-script name and an unbounded recursive walk,
both documented against the layout each exists for. `scripts/ci/sherpa-build-script-tests.test.mjs`
pins the lookup and the toolchain copy: both layouts, the other-crate control, the
prefix-sibling control, the any-depth case, the refuse-on-empty case, and the copy
itself, so a future cargo rename or a dropped copy fails a unit test with a clear
name instead of only the CI step.

The deeper lesson is the one the environment rule states: a measurement from one
runner is not a property of the project. Here it ran the other way, a runner's
default toolchain leaked into a step that was supposed to use the project's pin,
and the step only failed once the two diverged.
