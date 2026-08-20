# HANDOFF — Manual workflow change required (workflows permission)

The GitHub App token for this session lacks `workflows` scope, so the
following workflow change **cannot be pushed** from the arena branch. Apply
it manually if the Ubuntu Rust Transcription job keeps timing out.

## Context

`Test Rust Transcription (Ubuntu)` in `.github/workflows/test-package-rust-transcription.yml`
hit the 20-minute `timeout-minutes` ceiling (ran 20m18s) on PR #105 while
the macOS job finished in 2m44s and Windows in 4m13s. Ubuntu downloads
ONNX/whisper model artifacts over the network during the integration tests,
which is the slow part.

## Exact diff to apply

```diff
--- a/.github/workflows/test-package-rust-transcription.yml
+++ b/.github/workflows/test-package-rust-transcription.yml
@@ -16,7 +16,10 @@ jobs:
   test:
     name: Test Rust Transcription (${{ matrix.label }})
     runs-on: ${{ matrix.os }}
-    timeout-minutes: 20
+    # Ubuntu downloads ONNX/whisper model artifacts over the network during
+    # the integration tests; 20 minutes is too tight (macOS/Windows finish in
+    # ~2-4 min). Raised to 45 so the slowest runner has headroom.
+    timeout-minutes: 45
```

## Status

- Committed locally on `arena/01a01a61-mausvoice` then reverted before push
  because the token rejected it with:
  `refusing to allow a GitHub App to create or update workflow ... without workflows permission`
- Everything else (i18n locale sync, PR28 contract fix) is already pushed.
