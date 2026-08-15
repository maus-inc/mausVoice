# HANDOFF PROMPT — apply the release.yml audit fixes that the Arena agent could not push

Copy everything below this line into your agent on a device whose GitHub credentials have `workflows` permission.

---

You are completing a pre-release audit remediation for `maus-inc/mausVoice`. A previous agent fixed 8 audit findings on branch `arena/01a0071d-mausvoice`. Seven fixes are already committed and pushed in commit `7b56341` ("fix: resolve pre-release audit findings (CSP, capabilities, REVIEW.md, contract test)"). One file could not be pushed because the previous agent's GitHub App lacked the `workflows` permission: `.github/workflows/release.yml`.

Your job: apply exactly one patch to exactly one file, verify it byte-for-byte, commit, and push. Do not modify any other file. Do not rebase, squash, or amend existing commits.

## Preconditions — verify before doing anything

1. Clone/fetch `maus-inc/mausVoice` and check out branch `arena/01a0071d-mausvoice`.
2. Verify the branch head is `7b56341` (or a descendant of it — if commits were added after, that is fine; proceed as long as the next check passes).
3. Verify the current committed `release.yml` is the expected base version:

```bash
git rev-parse HEAD:.github/workflows/release.yml
# MUST print: 65ee386489e5cb5e289531b75146d1410b252b87
```

If it prints anything else, STOP and report — the file changed since the handoff was written and the patch must not be applied blindly.

## The change (context)

Three audit findings, all confined to `.github/workflows/release.yml`:

- **[Minor] verify-rust release gate too narrow:** it only ran `cargo test --lib` for `apps/desktop/src-tauri`. The gate now also tests `rust_transcription` (`--lib`), `rust_pill_shared`, and `rust_gtk_pill` — crates that ship in the release artifact. Requires adding `clang libclang-dev libgtk-layer-shell-dev` to the apt install and three cargo cache workspaces.
- **[Minor] publish-cask silent RELEASE_TOKEN dependency:** `TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}` — the fallback can never push to the cross-repo tap (`maus-inc/homebrew-mausvoice`), so a missing PAT 403s at the very last step of a release. A new fail-fast guard step asserts the secret exists before anything is downloaded, and the misleading fallback is removed.
- **[Nitpick] missing EOF newline.**

## Apply the patch

Save the following as `/tmp/release-yml.patch` EXACTLY as-is (do not retype it; copy verbatim including whitespace), then run `git apply --check /tmp/release-yml.patch && git apply /tmp/release-yml.patch` from the repo root.

```diff
diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
index 65ee386..bfeb607 100644
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -90,6 +90,9 @@ jobs:
         with:
           workspaces: |
             apps/desktop/src-tauri -> target
+            packages/rust_transcription -> packages/rust_transcription/target
+            packages/rust_pill_shared -> packages/rust_pill_shared/target
+            packages/rust_gtk_pill -> packages/rust_gtk_pill/target
           key: ubuntu-release-verify-rust
       - name: Install system dependencies
         run: |
@@ -100,14 +103,26 @@ jobs:
             WEBKIT_PKG=libwebkit2gtk-4.0-dev
           fi
           sudo apt-get install -y \
-            build-essential pkg-config cmake \
+            build-essential pkg-config cmake clang libclang-dev \
             libgtk-3-dev "$WEBKIT_PKG" \
-            libayatana-appindicator3-dev librsvg2-dev libasound2-dev libxdo-dev
+            libayatana-appindicator3-dev librsvg2-dev libasound2-dev libxdo-dev \
+            libgtk-layer-shell-dev
       - name: Run Rust unit tests
         working-directory: apps/desktop/src-tauri
         env:
           TAURI_CONFIG: '{"bundle":{"externalBin":[]}}'
         run: cargo test --lib
+      # The release gate must cover every crate that ships in the artifact,
+      # not just the Tauri backend: transcription (downloads, resume,
+      # ONNX inference plumbing) and the pill crates buildable on this runner.
+      - name: Run transcription unit tests
+        env:
+          CMAKE_TOOLCHAIN_FILE: ${{ github.workspace }}/packages/rust_transcription/cmake/linux-ci-toolchain.cmake
+        run: cargo test --manifest-path packages/rust_transcription/Cargo.toml --lib
+      - name: Run shared pill geometry tests
+        run: cargo test --manifest-path packages/rust_pill_shared/Cargo.toml
+      - name: Run Linux pill tests
+        run: cargo test --manifest-path packages/rust_gtk_pill/Cargo.toml

   build:
     name: Build ${{ matrix.label }}
@@ -365,6 +380,19 @@ jobs:
       - name: Checkout source
         uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262

+      # The cask lives in a different repository (maus-inc/homebrew-mausvoice),
+      # which the workflow-scoped GITHUB_TOKEN can never push to. Fail here,
+      # before downloading/rendering anything, instead of 403-ing on the final
+      # `git push` with an opaque error.
+      - name: Require RELEASE_TOKEN
+        env:
+          RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}
+        run: |
+          if [ -z "$RELEASE_TOKEN" ]; then
+            echo "::error::secrets.RELEASE_TOKEN is not set. Publishing the Homebrew cask requires a PAT with write access to maus-inc/homebrew-mausvoice; GITHUB_TOKEN cannot push cross-repo." >&2
+            exit 1
+          fi
+
       - name: Resolve tag
         id: tag
         env:
@@ -399,7 +427,9 @@ jobs:
       - name: Publish cask to tap
         env:
           VERSION: ${{ inputs.version }}
-          TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
+          # No GITHUB_TOKEN fallback: it cannot push to the tap repo, and the
+          # guard step above already failed fast if RELEASE_TOKEN is missing.
+          TOKEN: ${{ secrets.RELEASE_TOKEN }}
         run: |
           set -euo pipefail
           REPO_URL="https://x-access-token:${TOKEN}@github.com/maus-inc/homebrew-mausvoice.git"
@@ -413,4 +443,4 @@ jobs:
           git config user.email "release@maus-inc.local"
           git add Casks/mausvoice-desktop.rb
           git commit -m "mausvoice-desktop ${VERSION}" || echo "Cask unchanged"
-          git push origin main
\ No newline at end of file
+          git push origin main
```

## Post-apply verification (all three MUST pass)

```bash
# 1. Byte-exact result check
sha256sum .github/workflows/release.yml
# MUST print: cd35dfabd22093ac2ff24f5106e350c8bf711849d779b9a601e8b8eb51a63c29

# 2. Line count
wc -l < .github/workflows/release.yml
# MUST print: 446

# 3. YAML parses (any available parser; node example)
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('valid yaml')"
```

If check 1 fails but `git apply` succeeded, the patch text was mangled in transit (likely trailing-whitespace stripping by an editor). Re-save the patch verbatim and retry; do NOT hand-edit toward the checksum.

## Commit and push

Only `.github/workflows/release.yml` may be staged. Use exactly this commit message:

```bash
git add .github/workflows/release.yml
git status --short   # MUST show only: M  .github/workflows/release.yml
git commit -m "ci(release): harden verify-rust gate and publish-cask token handling

- verify-rust: extend the release gate beyond src-tauri --lib to
  rust_transcription (--lib), rust_pill_shared, and rust_gtk_pill so
  crates that ship in the artifact are tested before any platform build
  starts; add clang/libclang-dev/libgtk-layer-shell-dev deps and the
  matching cargo cache workspaces.
- publish-cask: fail fast with a clear error when RELEASE_TOKEN is unset
  instead of 403-ing on the cross-repo tap push at the end of a release;
  drop the misleading GITHUB_TOKEN fallback which can never push to
  maus-inc/homebrew-mausvoice.
- Add trailing newline at EOF.

Completes the audit remediation started in 7b56341, which could not
include workflow files (GitHub App lacked the workflows permission)."
git push origin arena/01a0071d-mausvoice
```

## Constraints

- Work ONLY on branch `arena/01a0071d-mausvoice`. Never force-push, never amend `7b56341`, never touch any file other than `.github/workflows/release.yml`.
- If the push is rejected for permissions again, report the exact error and stop.
- Success criteria: `git ls-remote origin arena/01a0071d-mausvoice` resolves to your new commit, and `git show origin/arena/01a0071d-mausvoice:.github/workflows/release.yml | sha256sum` yields `cd35dfabd22093ac2ff24f5106e350c8bf711849d779b9a601e8b8eb51a63c29`.
