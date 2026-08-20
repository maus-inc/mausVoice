# HANDOFF: CI workflow timeout (applied)

The `Test Rust Transcription (Ubuntu)` job in `.github/workflows/test-package-rust-transcription.yml` hit the 20-minute `timeout-minutes` ceiling while macOS finished in under 3 minutes and Windows in under 5. Ubuntu downloads ONNX/whisper model artifacts over the network during integration tests, which is the slow part.

The timeout was raised from 20 to 45 minutes. This change landed on `fix/superfix-review-findings` and is now part of the main workflow file.

No further action needed on this item.
