# Personal fork merge inventory

Branch: `arena/019fd252-mausvoice` → base `free-fix`
Source: personal fork commits from PR #2 (`Owie6789/mausvoice-private`)
PR: https://github.com/maus-inc/mausvoice/pull/3

## Method

`free-fix` is a single squashed commit with **unrelated git history** from the personal
fork, so a direct merge was impossible. All personal-fork commits were **cherry-picked**
onto `free-fix` in order, conflicts resolved, commits preserved.

## Commits applied (in order)

```
d9a93b89 chore: drop temporary workflow patch (replaced by personal-fork-ci/)
03369f72 ci: package personal-fork workflows for apply-on-push
98e89b5a chore: keep free-fix GitHub workflows for pushability
0b2d9b3f docs: drop stale mobile section from AGENTS.md
778ae745 Format: fix spacing/indentation in pill.rs after merge
64838808 Fix formatting of font height assignment
64af6551 Add tooltip hover detection logic
8cf1246d Add workflow for releasing unsigned desktop binaries
01d18926 docs: update for Deepgram streaming transcription
83a4c357 feat(desktop): streaming Deepgram dictation with in-app API keys
55a8cf63 docs: relocate keyboard-listener hardening plan into docs/
86a81de0 Sync i18n locale strings
b69a47ec Harden macOS keyboard listener and add hold-to-talk dictation
b1354800 docs: personal-build README + architecture walkthrough
4a1f641c Personal local-only fork: local Groq mode, drop paywall, mobile, and Linux
```

## Fidelity vs personal fork (PR #2 tip)

- Paths in personal-fork delta identical on HEAD: **629**
- Paths that intentionally differ (free-form polish kept): **16**
- Paths missing from `.github/workflows` but packaged: see below

### Intentional content differences (kept free-form polish over older fork base)

| File | Why HEAD differs from personal fork |
|------|-------------------------------------|
| `.github/scripts/install-desktop-linux-deps.sh` | kept temporarily: token cannot delete/update workflows that reference it; personal-fork-ci omits it |
| `.github/workflows/_release-desktop-impl.yml` | live file is free-form; personal-fork version in `personal-fork-ci/workflows/` |
| `.github/workflows/build-desktop.yml` | same — packaged under personal-fork-ci |
| `.github/workflows/lint-desktop.yml` | same — packaged under personal-fork-ci |
| `.github/workflows/release-cli.yml` | same — packaged under personal-fork-ci |
| `apps/desktop/package.json` | free-form dependency bumps (`react-router-dom` ^6.30.4, `@types/node`) |
| `apps/desktop/src-tauri/src/app.rs` | free-form `set_tray_language_menu` command registration |
| `apps/desktop/src-tauri/src/commands.rs` | free-form tray language menu command |
| `apps/desktop/src-tauri/src/system/tray.rs` | free-form tray: Language submenu + Copy Latest Transcript |
| `apps/desktop/src/actions/updater.actions.ts` | free-form beta-update surfacing (`shouldSurfaceUpdate`) |
| `apps/desktop/src/components/dashboard/DashboardMenu.tsx` | free-form beta-update badge gating |
| `apps/desktop/src/components/root/AppSideEffects.tsx` | free-form tray language sync + copy-last-transcript listener |
| `apps/desktop/src/repos/generate-text.repo.ts` | free-form `GENERATE_TEXT_MODELS` validation + personal default `gpt-oss-20b` |
| `apps/desktop/src/repos/index.ts` | free-form `DeepgramTranscribeAudioRepo` batch provider wiring |
| `apps/desktop/src/utils/user.utils.ts` | free-form Active Dictation Language / configured languages helpers |
| `packages/voice-ai/src/groq.utils.ts` | free-form model list extras; personal default remains `gpt-oss-20b` |
| `.github/workflows/release-unsigned.yml` | missing at path; packaged at `personal-fork-ci/workflows/release-unsigned.yml` |

### Pill hover fix

`packages/rust_windows_pill/src/pill.rs` is **byte-identical** to personal fork (PR #2).
Includes tooltip hover detection so the pill does not fade while the cursor is on the tooltip.

## KEPT — Personal fork features (what you wanted)

### Product / paywall
- Personal-use mode via `isPersonalUseEnabled` / `isPersonalUseProEnabled` (always on)
- No paywall / Pro account gating; local personal user
- In-app Deepgram + Groq API keys (onboarding `PersonalCredentialsForm` + Settings)
- Keys encrypted at rest with XChaCha20-Poly1305 (`crypto.rs`)
- Deepgram nova-3 **streaming** transcription (live while speaking); default language `multi`
- Groq `openai/gpt-oss-20b` post-processing default
- Fully-local Whisper path still available
- Settings page reworked for personal credentials (Deepgram/Groq rotate/clear)
- Multi-device dialog stripped of cloud pairing noise where personal fork did so

### Dictation / keyboard
- macOS keyboard listener hardening (vendored/patched `rdev`, tap re-enable on timeout)
- Listener health lifecycle + TS surface (`get_key_listener_health`, health events, retry)
- Hold-to-talk dictation (`ActivationController.holdToTalk`, "Hold to dictate" copy)
- Fn watchdog / dead-tap recovery
- i18n locale sync for new strings

### Windows pill
- Tooltip hover detection (pill stays visible on tooltip hover)
- Font height / spacing formatting fixes after merge

### Platform scope
- **Removed** entire Flutter `mobile/` app (366 files)
- **Removed** `packages/flutter_video_looper` (89 files)
- **Removed** Linux desktop platform (`apps/desktop/src-tauri/src/platform/linux/**`)
- **Removed** Linux packaging (archlinux PKGBUILD, setup-linux.sh, wayland docs)
- **Removed** mobile QR assets + MobileApp dialogs + NativeSetupDialog
- Dev scripts: no `dev:linux` / `dev:linux:gpu`

### Docs
- Personal-build `README.md` + `README.original.md`
- `docs/ARCHITECTURE.md`
- `docs/keyboard-listener-hardening.md`
- Getting-started updated for Deepgram/Groq in-app keys
- AGENTS.md: mobile section removed

### CI (intent)
- `personal-fork-ci/workflows/release-unsigned.yml` — unsigned macOS/Windows desktop binaries
- Linux stripped from desktop release/build/lint matrices (packaged; apply via APPLY.md)
- Slimmed `release-cli.yml` for personal build

## KEPT — free-form polish that post-dates the fork base

These exist on free-form / HEAD but not on the personal fork tip. Kept on purpose
so you get the newer polished code rather than regressing:

- `.github/scripts/install-desktop-linux-deps.sh`
- `.github/workflows/retry-release.yml`
- `apps/desktop/CONTEXT.md`
- `apps/desktop/docs/adr/0001-tray-language-menu-is-ts-driven.md`
- `apps/desktop/src/repos/preferences.repo.test.ts`
- `apps/desktop/src/utils/tray-language.utils.test.ts`
- `apps/desktop/src/utils/tray-language.utils.ts`
- `apps/desktop/src/utils/user.utils.test.ts`
- Tray language menu (TS-driven) + Copy Latest Transcript tray item
- Active dictation language helpers + preferences tests
- Deepgram **batch** `DeepgramTranscribeAudioRepo` provider option (alongside streaming)
- Beta update surfacing (`shouldSurfaceUpdate` / `optInToBetaUpdates`)
- free-form release orchestrator: `workflow_dispatch`, `retry-release.yml`
- Dependency bumps in desktop package.json

## REMOVED from free-form (personal fork intent)

Total paths deleted: **493**

### linux platform & packaging (33 files)

- `apps/desktop/scripts/setup-linux.sh`
- `apps/desktop/src-tauri/archlinux/.SRCINFO`
- `apps/desktop/src-tauri/archlinux/PKGBUILD`
- `apps/desktop/src-tauri/icons/tray/menu-item-win-linux-36.png`
- `apps/desktop/src-tauri/icons/tray/update-win-linux-36.png`
- `apps/desktop/src-tauri/src/platform/linux/accessibility.rs`
- `apps/desktop/src-tauri/src/platform/linux/audio.rs`
- `apps/desktop/src-tauri/src/platform/linux/compositor.rs`
- `apps/desktop/src-tauri/src/platform/linux/detect.rs`
- `apps/desktop/src-tauri/src/platform/linux/feedback.rs`
- `apps/desktop/src-tauri/src/platform/linux/init.rs`
- `apps/desktop/src-tauri/src/platform/linux/input.rs`
- `apps/desktop/src-tauri/src/platform/linux/keyboard.rs`
- `apps/desktop/src-tauri/src/platform/linux/keyboard_language.rs`
- `apps/desktop/src-tauri/src/platform/linux/mod.rs`
- `apps/desktop/src-tauri/src/platform/linux/monitor.rs`
- `apps/desktop/src-tauri/src/platform/linux/overlay.rs`
- `apps/desktop/src-tauri/src/platform/linux/permissions.rs`
- `apps/desktop/src-tauri/src/platform/linux/position.rs`
- `apps/desktop/src-tauri/src/platform/linux/volume.rs`
- `apps/desktop/src-tauri/src/platform/linux/window.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/accessibility.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/compositor.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/init.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/input.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/mod.rs`
- `apps/desktop/src-tauri/src/platform/linux/wl/setup.rs`
- `apps/desktop/src-tauri/src/platform/linux/x11/accessibility.rs`
- `apps/desktop/src-tauri/src/platform/linux/x11/init.rs`
- `apps/desktop/src-tauri/src/platform/linux/x11/input.rs`
- `apps/desktop/src-tauri/src/platform/linux/x11/keyboard.rs`
- `apps/desktop/src-tauri/src/platform/linux/x11/mod.rs`
- `docs/wayland-hotkeys-wlroots.md`

### desktop mobile UI (5 files)

- `apps/desktop/src/assets/qr-code-android.png`
- `apps/desktop/src/assets/qr-code-ios.png`
- `apps/desktop/src/components/dashboard/MobileAppDialog.tsx`
- `apps/desktop/src/components/dashboard/MobileAppListTile.tsx`
- `apps/desktop/src/components/root/NativeSetupDialog.tsx`

### mobile/ (366 files)

- `mobile/.env.example`
- `mobile/.gitignore`
- `mobile/.metadata`
- `mobile/README.md`
- `mobile/analysis_options.yaml`
- `mobile/android/.gitignore`
- `mobile/android/app/build.gradle.kts`
- `mobile/android/app/src/debug/AndroidManifest.xml`
- `mobile/android/app/src/dev/google-services.json`
- `mobile/android/app/src/dev/res/values/strings.xml`
- `mobile/android/app/src/emulators/google-services.json`
- `mobile/android/app/src/emulators/res/values/strings.xml`
- `mobile/android/app/src/main/AndroidManifest.xml`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/MainActivity.kt`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/mausVoiceIME.kt`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/repos/ApiUtils.kt`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/repos/GenerateTextRepo.kt`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/repos/RepoConfig.kt`
- `mobile/android/app/src/main/kotlin/com/mausvoice/mobile/repos/TranscribeAudioRepo.kt`
- `mobile/android/app/src/main/res/drawable-hdpi/ic_launcher_foreground.png`
- `mobile/android/app/src/main/res/drawable-mdpi/ic_launcher_foreground.png`
- `mobile/android/app/src/main/res/drawable-night/keyboard_background.xml`
- `mobile/android/app/src/main/res/drawable-v21/launch_background.xml`
- `mobile/android/app/src/main/res/drawable-xhdpi/ic_launcher_foreground.png`
- `mobile/android/app/src/main/res/drawable-xxhdpi/ic_launcher_foreground.png`
- … and 341 more under this category

### packages/flutter_video_looper/ (89 files)

- `packages/flutter_video_looper/.gitignore`
- `packages/flutter_video_looper/.metadata`
- `packages/flutter_video_looper/CHANGELOG.md`
- `packages/flutter_video_looper/LICENCE`
- `packages/flutter_video_looper/LICENSE`
- `packages/flutter_video_looper/README.md`
- `packages/flutter_video_looper/analysis_options.yaml`
- `packages/flutter_video_looper/android/.gitignore`
- `packages/flutter_video_looper/android/build.gradle`
- `packages/flutter_video_looper/android/settings.gradle`
- `packages/flutter_video_looper/android/src/main/AndroidManifest.xml`
- `packages/flutter_video_looper/android/src/main/kotlin/com/mausvoice/flutter_video_looper/FlutterVideoLooperPlugin.kt`
- `packages/flutter_video_looper/android/src/main/kotlin/com/mausvoice/flutter_video_looper/VideoLooperView.kt`
- `packages/flutter_video_looper/example/.gitignore`
- `packages/flutter_video_looper/example/README.md`
- `packages/flutter_video_looper/example/analysis_options.yaml`
- `packages/flutter_video_looper/example/android/.gitignore`
- `packages/flutter_video_looper/example/android/app/build.gradle.kts`
- `packages/flutter_video_looper/example/android/app/src/debug/AndroidManifest.xml`
- `packages/flutter_video_looper/example/android/app/src/main/AndroidManifest.xml`
- `packages/flutter_video_looper/example/android/app/src/main/kotlin/com/mausvoice/flutter_video_looper_example/MainActivity.kt`
- `packages/flutter_video_looper/example/android/app/src/main/res/drawable-v21/launch_background.xml`
- `packages/flutter_video_looper/example/android/app/src/main/res/drawable/launch_background.xml`
- `packages/flutter_video_looper/example/android/app/src/main/res/mipmap-hdpi/ic_launcher.png`
- `packages/flutter_video_looper/example/android/app/src/main/res/mipmap-mdpi/ic_launcher.png`
- … and 64 more under this category

## ADDED relative to free-form (high-signal paths)

Total added paths: **73** (incl. vendored patches)

### App / docs / config
- `README.original.md`
- `apps/desktop/.env.local.example`
- `apps/desktop/src-tauri/icons/tray/menu-item-windows-36.png`
- `apps/desktop/src-tauri/icons/tray/update-windows-36.png`
- `apps/desktop/src/actions/personal-use.actions.ts`
- `apps/desktop/src/components/onboarding/PersonalCredentialsForm.tsx`
- `apps/desktop/src/utils/personal-use.utils.test.ts`
- `apps/desktop/src/utils/personal-use.utils.ts`
- `docs/ARCHITECTURE.md`
- `docs/keyboard-listener-hardening.md`

### Vendored patches (`patches/`) — 57 files
- `patches/rdev/**` — macOS event-tap re-enable + keyboard listener fix
- `patches/block-0.1.6/**` — dependency patch for rdev stack

### Packaged CI (`personal-fork-ci/`) — 6 files
- `personal-fork-ci/APPLY.md`
- `personal-fork-ci/workflows/_release-desktop-impl.yml`
- `personal-fork-ci/workflows/build-desktop.yml`
- `personal-fork-ci/workflows/lint-desktop.yml`
- `personal-fork-ci/workflows/release-cli.yml`
- `personal-fork-ci/workflows/release-unsigned.yml`

## MODIFIED relative to free-form (count)

**84** files changed in place (personal-fork logic merged into free-form base).
Major areas: desktop actions/components/repos/state/utils, tauri commands/platform/crypto,
i18n locales, packages/desktop-utils activation, packages/desktop-native-apis bindings,
voice-ai groq defaults, README/docs.

## Known limitation (workflows permission)

This environment’s GitHub token **cannot push changes under `.github/workflows/`**.
Therefore:
- Live `.github/workflows/*` on the branch still match free-form (includes Linux matrix).
- Personal-fork workflow intent is complete under `personal-fork-ci/workflows/`.
- Apply with `personal-fork-ci/APPLY.md` when you have a token/user with `workflows` permission.
- `release-unsigned.yml` is **only** under `personal-fork-ci/` until applied.

## Verification checklist

- [x] Pill hover: identical to personal fork
- [x] Personal-use / no paywall: present
- [x] Deepgram streaming + in-app keys: present
- [x] Hold-to-talk + keyboard hardening: present
- [x] Mobile removed: yes (366 files)
- [x] Linux platform removed: yes
- [x] Commits preserved as cherry-picks (not squashed into one blob)
- [ ] Workflows live under `.github/workflows/`: pending APPLY.md (token limit)
- [x] free-form merge: CLEAN / MERGEABLE on PR #3
