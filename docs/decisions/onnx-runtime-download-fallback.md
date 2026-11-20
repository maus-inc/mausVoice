# A build must not depend on one upstream release URL

Date: 2026-11-17
Status: accepted

## Context

`packages/rust_transcription/build.rs` downloaded the ONNX Runtime archive from a
single URL, `https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/<archive>`.
On 2026-11-17 Microsoft made `microsoft/onnxruntime` and its sibling repositories
private. The repository, its tags and every release asset returned 404, so `Build
Desktop` failed on Linux, macOS and Windows in the same step. The build had no
second source and no way to point it at one.

The same failure reached `patches/sherpa-onnx-sys-1.13.5/build.rs`, whose
`k2-fsa/sherpa-onnx` release was still reachable. That file already accepts a local
archive through `SHERPA_ONNX_ARCHIVE_DIR`, which is why it did not fail.

## Decision

`download_verified` now walks an ordered list of base URLs and returns on the first
one whose bytes match the pinned SHA-256. The GitHub release stays first, and
`https://registry.npmmirror.com/-/binary/onnxruntime/v{ORT_VERSION}` is the
fallback. `MAUSVOICE_ORT_DOWNLOAD_BASE_URLS` overrides the list for an internal
mirror or an air-gapped build.

A download error now carries whether it is retryable. A 4xx response and a digest
mismatch are terminal, so the loop moves to the next source instead of replaying a
request the source will never answer. A timeout or a 5xx stays retryable.

Every source is verified against the same pin, so a mirror cannot substitute
different bytes. It either serves the file the pin names or is rejected.

Rejected: a hardcoded second URL with no override, because an air-gapped release
build cannot reach either host. Rejected: downloading without the digest check,
because that would let a compromised mirror serve arbitrary native code.

## Consequences

A single upstream release disappearing no longer stops every desktop build. The
cost is that the build now knows a mirror host it did not before, so a future
contributor auditing outbound hosts sees `registry.npmmirror.com` in the download
path. The fallback host is named in one place, `download_base_urls`, and the
contract test `scripts/ci/verify-ort-archives.test.mjs` pins the source order and
mirror override. `cargo test --locked --manifest-path packages/rust_transcription/Cargo.toml --test ort_download`
uses local HTTP responses to check retry limits, digest validation and fallback.

Each attempt waits at most 30 seconds for response headers after sending the GET,
even when the server sends partial headers. Body reads keep their separate
300-second timeout. The final error names sources by their position in the
configured list. It includes HTTP status codes and digest failures without printing
mirror URLs or credentials.
