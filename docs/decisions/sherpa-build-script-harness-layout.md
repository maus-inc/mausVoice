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
   This is the root cause: the probe was compiling with a compiler the project does
   not build with.

2. The build-script lookup walks the package's own subtree and accepts both cargo
   spellings, `build-script-build` and `build_script_build`, at any depth. It no
   longer hard-codes the pre-1.100 path. The walk is bounded and confined to the
   `sherpa-onnx-sys` directory, so a dependency's build script, which is also named
   `build_script_build`, cannot be mistaken for this one. The "exactly one or
   refuse" contract is unchanged.

Rejected: pinning the harness to a cargo version by string. The toolchain belongs in
`rust-toolchain.toml`, which the repository already owns, and a second copy of the
pin would drift from it. Rejected: making the lookup tolerant of zero matches. The
harness exists to refuse when it cannot inspect the artifact, so a layout it does
not recognise has to fail loudly rather than pass quietly.

## Consequences

The step no longer breaks when the runner's default stable moves ahead of the
pinned toolchain, which is what happened here. The cost is that the harness now
carries two spellings of cargo's build-script name and a bounded recursive walk,
both documented against the layout each exists for. `scripts/ci/sherpa-build-script-tests.test.mjs`
pins the new function: both layouts, the other-crate control, and the refuse-on-empty
case, so a future cargo rename fails a unit test with a clear name instead of only
the CI step.

The deeper lesson is the one the environment rule states: a measurement from one
runner is not a property of the project. Here it ran the other way, a runner's
default toolchain leaked into a step that was supposed to use the project's pin,
and the step only failed once the two diverged.
