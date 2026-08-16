# PR #59 Review — `feat(updater): working end-to-end auto-update pipeline`

**Branch:** `arena/01a00791-mausvoice` → `main`
**Repo:** `maus-inc/mausVoice`
**Confidence:** High (CI green; findings from static analysis + simulated manifest builds, not a live release)

---

## 1. Verdict

**NOT READY TO MERGE.**

The pipeline is correctly wired end-to-end for **macOS and Linux (AppImage)** users, and the Critical plaintext-key problem from `main` is genuinely fixed. But the updater is **dead on arrival for Windows** — the single platform the PR explicitly targets ("Windows lacks a native toast so this matters most") — and is **broken for Linux `.deb`/`.rpm` installs**. Because `get_urls()` runs *before* `should_update()`, these failures surface as a permanent "Could not check for updates" error on every poll, not a silent no-op.

Merge only after the Windows/Linux installer-key gaps are closed and the release-body `.sig` misclassification is fixed.

---

## 2. Major findings

### 🔴 Critical — Windows updater is non-functional (no matching manifest entry)
Two compounding defects:

1. **Artifact name mismatch.** With Tauri v2 + `createUpdaterArtifacts: true` (the "direct-sign" mode the release job uses), Windows artifacts are `mausVoice_x.x.x_x64.msi` + `mausVoice_x.x.x_x64.msi.sig` (and `.exe`/`.exe.sig`). There is **no `.nsis.zip`**. The manifest builder only emits a `windows-x86_64` entry when it sees `.nsis.zip`:
   - `scripts/ci/build-updater-manifest.mjs:36` — `name.endsWith(".nsis.zip")` for Windows.
   - `.github/workflows/release.yml:332` and `:452` — upload globs `**/*.nsis.zip` / `dist/**/*.nsis.zip` match nothing.
   I simulated the real v2 artifact set through the builder: macOS + Linux entries are produced, **Windows produces no entry at all**.

2. **`get_urls` runs before `should_update`, so the missing key is fatal.** In `tauri-plugin-updater` (`updater.rs:1442`), `get_urls(self, &update, &self.signature_path)` is called unconditionally at the top of `check`, *before* `should_update()` is evaluated. With no `windows-x86_64` key in `latest.json`, `get_urls` returns `Err(TargetsNotFound)` → the whole `check` rejects → every Windows poll shows "Could not check for updates." This is not a "no update available" path; it is an error path.

**Fix:** either set `createUpdaterArtifacts: "v1Compatible"` (restores `.nsis.zip` + `.nsis.zip.sig`, which the existing matcher already expects), or — preferably for v2 signatures — emit per-installer keys. The plugin resolves `{os}-{arch}-{installer}` first, then falls back to `{os}-{arch}`. A Windows MSI-installed app looks for `windows-x86_64-msi`; an NSIS-installed app looks for `windows-x86_64-nsis`. Emitting only a bare `windows-x86_64` (pointing at, say, the MSI) would let an NSIS install pull the MSI and create a duplicate Add/Remove entry. Emit `windows-x86_64-nsis` and `windows-x86_64-msi` (and the bare fallback) from the real `.exe`/`.msi` + `.sig` artifacts, and update `release.yml` globs accordingly (`:332`, `:450-457`).

### 🟠 Major — Linux `.deb`/`.rpm` installs cannot update
The manifest emits only `linux-x86_64` (AppImage URL) for Linux. A `.deb`-installed app returns `BundleType::Deb` (`commands.rs`/`updater.rs installer_for_bundle_type:1504`), so `get_urls` first seeks `linux-x86_64-deb`, misses, then falls back to `linux-x86_64` (the AppImage URL) and calls `install` → `InvalidUpdaterFormat`. `.rpm` is symmetric. So anyone who installed via the Debian/RPM package gets a broken updater. **Fix:** emit `linux-x86_64-appimage`, `linux-x86_64-deb`, and `linux-x86_64-rpm` entries.

### 🟠 Major — Release notes list `.sig` signature files as downloads
`scripts/ci/generate-release-body.mjs` `classify()` (`:60-72`) matches `lower.includes("setup") || lower.includes("installer") || ext === ".exe"`. A `mausVoice_x.x.x_x64-setup.exe.sig` file contains "setup" and its ext is `.sig`, so it is classified as a **Windows installer** and rendered as a clickable download link. I simulated it: with only `mausVoice_0.1.7_x64-setup.exe.sig` in the asset list, the output is `| Windows | [mausVoice_0.1.7_x64-setup.exe.sig](...)|`. Users get a raw signature file instead of an installer. **Fix:** exclude `*.sig` from `classify()` (and ideally match on the full filename pattern, not a substring of "setup").

### 🟠/🟡 Major-to-Minor — macOS manual-install fallback URL and `validate_installer_url` assume `.pkg`
`packages/desktop-utils/src/updater.ts:138` builds `mausVoice_${version}_universal.pkg` for the "download installer" manual path, but Tauri v2 (direct-sign) produces `.dmg` + `.app.tar.gz`, **never `.pkg`** — so the macOS manual-install link 404s. Worse, `apps/desktop/src-tauri/src/commands.rs:3285` `validate_installer_url` hard-requires `.pkg`; a corrected `.dmg` URL would be rejected by the command itself. **Fix:** use the `.dmg` URL and relax/extend the validator to accept `.dmg` (and `.app.tar.gz`).

### 🟠 Verify — `personal-fork-ci` workflows rely on YAML anchors
`personal-fork-ci/workflows/build-desktop.yml` uses `*build-desktop-paths` YAML aliases. Historically GitHub Actions rejects anchors with "Anchors are not currently supported." The main `.github/workflows/build-desktop.yml` inlines the paths, avoiding this risk; the personal-fork one does not. The PR body claimed these workflows "could NOT be pushed," yet they are present on the branch — confirm the anchor actually parses in GitHub Actions before relying on the personal-fork CI. (If GitHub still rejects anchors, those jobs fail to load.)

---

## 3. Minor findings

### 🟡 — Docs contradict the fail-closed release behavior
`docs/RELEASE.md:12-13` says "Without them the run still succeeds and simply publishes installers with no `latest.json`," and `apps/docs/src/content/docs/development/auto-update.md:43` says the updater "degrades gracefully" without secrets. But `release.yml:418` **fails closed** for a stable release when `UPDATER_SIGNING_PRIVATE_KEY`/`UPDATER_SIGNING_PRIVATE_KEY_PASSWORD` are missing (`::error::Configure the UPDATER_* secrets`). The docs are stale relative to commit `9cd69123`. Update both to describe the actual fail-closed gate.

### 🟡 — `GITHUB_REPOSITORY` fork fallback points the manifest at the wrong repo
`build-updater-manifest.mjs` uses `process.env.GITHUB_REPOSITORY ?? "maus-inc/mausVoice"`. If a fork runs `release.yml`, the manifest's `url` base becomes the fork, while shipped client endpoints are pinned to `maus-inc/mausVoice` (`tauri.conf.json:73`). Fork-released manifests would 404 for real clients. Acceptable as a known limitation, but worth a comment in the script.

### 🟡 — Confirm `analytics-equivalence.test.ts` is not tautological
A new `apps/desktop/src/.../analytics-equivalence.test.ts` was added. Per house rules, dynamic-snapshot tests must assert real behavior, not just echo inputs. Skim it to confirm the equivalence check extracts/compares actual fields rather than asserting `a === a`. (Not fully read in this pass.)

---

## 4. Nitpick findings

- `build-updater-manifest.mjs` duplicates the platform→filename-suffix logic inline; a small `PLATFORM_SUFFIXES` map would remove the copy-paste across macOS (aarch64/x86_64), Windows, and Linux branches.
- `generate-release-body.mjs` "universal"/"aarch64"/"x64" classification keys off raw substrings; consolidate with the manifest builder's platform constants to avoid drift between the two scripts.

---

## 5. UI review findings

- `apps/desktop/src/components/settings/UpdateSettingSection.tsx` adds a manual "Check for updates" + status line. Good. But the status text must distinguish **"update available"** from **"could not check"** — under the Windows/Linux-deb breaks above, users will see a permanent error string here, which reads like a broken app rather than "up to date." Resolve the root causes before judging copy.
- Tray badge sync (`syncMenuIcon` in `checkForAppUpdates`) and the `checkingUserInitiated` coalescing are correct and fix the prior stale-badge regression. No UI nit beyond the status-string clarity above.

---

## 6. Missing important test coverage

- **No test asserts the Windows entry is produced** under the v2 artifact set. The existing `updater-manifest.test.mjs` (9/9 green) feeds fixtures that include `.nsis.zip`; add a fixture using the *real* v2 Windows names (`.msi` + `.msi.sig`, `.exe` + `.exe.sig`) and assert a `windows-x86_64` (and ideally `-nsis`/`-msi`) key is emitted. This would have caught the Critical.
- **No test covers `generate-release-body.mjs` `.sig` exclusion.** Add a case with `*.exe.sig` present and assert it is *not* listed as a download.
- **No integration test for per-installer-type keys** (deb/rpm/nsis/msi). The plugin's `{os}-{arch}-{installer}` resolution is the crux; cover it.
- **`tauri-conf.test.ts`** (endpoint https + `maus-inc` + empty `pubkey`) is good and should be extended to assert `createUpdaterArtifacts` is falsy in the base config.

---

## 7. What is working correctly

- ✅ **No committed signing key / pubkey literal.** `tauri.conf.json:75` `pubkey:""`, `:40` `createUpdaterArtifacts:false` in the shipped config; `TAURI_CI_PUBKEY` removed from `build-desktop.yml`; keys live only in repo secrets. The Critical issue from `main` is genuinely resolved.
- ✅ **Endpoint points at the correct repo** (`maus-inc/mausVoice`, `tauri.conf.json:73`); `GITHUB_RELEASE_DOWNLOAD_BASE` in `updater.ts` matches. The old `mausvoice/mausvoice` typo is gone.
- ✅ **`latest.json` is now produced** via `build-updater-manifest.mjs` + `release.yml` (eligibility gate at `:280`), with a real unit-test suite (9/9).
- ✅ **macOS + Linux (AppImage) manifest entries generate correctly** from real v2 artifact names (`darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`).
- ✅ **Startup dismissed-dialog regression fixed:** `dismissUpdateDialog` now fires only from `UpdateDialog.tsx:131`, not on app boot.
- ✅ **Dev-mode skip** via `getIsDevMode()` in `checkForAppUpdates`; **6h poll** (`AppSideEffects.tsx:122`); **tray badge sync** retained; **updater state not persisted** (store partialize `local` only) so a dismissed update re-surfaces on next launch.
- ✅ **Workflows are least-privilege** (scoped `contents`/`actions`/`packages` per job) with pinned SHA actions and a `permissions:` block — good security hygiene.
- ✅ **Prerelease/version-agreement gate + fail-closed** for unsigned stable releases is a sound safety net.

---

## Recommended merge gate
1. Windows manifest entry produced from real v2 artifacts (`v1Compatible` or per-installer keys) — **blocks merge**.
2. Linux deb/rpm entries emitted — **blocks merge**.
3. `generate-release-body.mjs` excludes `*.sig` — **blocks merge**.
4. macOS manual-install URL → `.dmg` + `validate_installer_url` accepts `.dmg` — should-fix.
5. Docs reconciled with fail-closed behavior; `personal-fork-ci` YAML-anchor support verified — nice-to-have.
