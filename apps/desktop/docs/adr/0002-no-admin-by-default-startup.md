# The app does not start elevated by default

mausVoice runs as a normal user process on every platform. Elevation is never
requested at startup. On Windows it is offered as an explicit, user-initiated
step (`run_native_setup`), and declining it leaves the app fully usable.

## Why

The request was "run as administrator so the accessibility permission is
already granted". Elevation does not do that on any of our platforms:

- **macOS (TCC).** Accessibility is granted per code-signed application through
  Transparency, Consent and Control, and the user must approve it in System
  Settings. Running as root does not pre-approve TCC; a privileged process is
  still denied until the app itself is listed under Privacy & Security →
  Accessibility.
- **Linux (AT-SPI).** Assistive technology talks over the user's session bus.
  Running as root moves the process off that bus and generally makes input
  integration *worse*, not better.
- **Windows (UAC/UIPI).** There is no accessibility permission to grant. The
  dictation hotkey is a low-level keyboard hook, which a standard user can
  install. Elevation only affects User Interface Privilege Isolation: an
  unelevated hook cannot see input delivered to a window running at a higher
  integrity level.

So admin-by-default buys nothing on two platforms and, on the third, buys only
a narrow UIPI edge case. Against that, every dictation keystroke and every
clipboard write would run with full administrative rights, and an always-
elevated app cannot be launched by the normal per-user autostart mechanisms.
That is a poor trade for a always-running background tool.

## What we do instead

- The app starts unelevated everywhere.
- Windows offers elevation on demand via `run_native_setup`, which relaunches
  through a bootstrap helper so the singleton lock is free before the elevated
  copy starts. Cancelling UAC returns `Cancelled` and the app keeps running.
- Onboarding's accessibility step is skippable, so declining or being unable
  to complete Windows elevation cannot block the flow. On platforms with a
  changing accessibility permission, `PermissionSideEffects` keeps polling
  and detects a later grant without a restart.
- `platform/windows/permissions.rs` reports accessibility as `Authorized`
  because hotkeys genuinely work unelevated. This state gates both the key
  listener (`AppSideEffects`) and the blocking `PermissionsDialog`, so
  reporting anything else disables dictation for every standard install — the
  cause of a previous "audio stopped working" regression.
- The Linux stub reports a state that lets onboarding continue, matching the
  behaviour above.

## Consequences

On Windows, hotkeys are ignored while a window running at a higher integrity
level has focus (Task Manager, an elevated terminal, some installers). Users
who need dictation in those windows can opt into elevation from Settings. This
is documented as a known limitation rather than being forced on everyone.
