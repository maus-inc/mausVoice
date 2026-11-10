/**
 * Verification harness for the microphone readiness UI.
 *
 * Renders the REAL `MicrophoneDialog` and the REAL readiness side-effecting
 * component against a fake native bridge, at routes the probe scripts can drive.
 * Nothing here ships: it exists so the dialog can be seen, measured and
 * screenshotted outside the Tauri runtime, which is the only place the rest of
 * the suite ever exercises it by reading the DOM.
 */
import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { THEME_PROVIDER_CONFIG, theme } from "@desktop/theme";
import en from "@desktop/i18n/locales/en.json";

/**
 * A deterministic stand-in for the Tauri command surface.
 *
 * The app reaches the native side through `@tauri-apps/api/core`'s `invoke`,
 * which is a thin wrapper over `window.__TAURI_INTERNALS__.invoke`. Installing
 * that object is therefore the same seam the real WebView uses: no component is
 * mocked or forked, and the command names and payloads below are the real ones.
 */
const stats = {
  warm: 0,
  close: 0,
  prepare: 0,
  linger: [] as number[],
  preroll: [] as number[],
};
const unhandled = new Set<string>();
let storedPreferences: unknown = null;

const handlers: Record<string, (args: any) => unknown> = {
  microphone_ready: () => (window as any).__held === true,
  warm_microphone: (args) => {
    stats.warm += 1;
    stats.linger.push(args.lingerMs);
    (window as any).__held = true;
    return null;
  },
  close_microphone: () => {
    stats.close += 1;
    (window as any).__held = false;
    return null;
  },
  prepare_microphone: () => {
    stats.prepare += 1;
    return "Fake Microphone";
  },
  set_microphone_linger: (args) => {
    stats.linger.push(args.lingerMs);
    return null;
  },
  // A policy-only command: it opens no device, so the fake can just record it.
  // Without it the pre-roll slider still moved, because the failure was caught
  // and logged as a warning -- which is exactly why the probe reports unmapped
  // commands instead of relying on a visible error.
  set_microphone_preroll: (args) => {
    stats.preroll.push(args.prerollSeconds);
    return null;
  },
  microphone_readiness_report: () =>
    "ready=false policy=cold preroll_ms=500 preroll_samples=0 last_start=none",
  capture_startup_timing: () => [],
  // Device enumeration is a real command, and returning an empty list would
  // make the dialog look broken in a way the real app is not.
  //
  // The field is `label`, not `name`, and `caution` is required by
  // `InputDeviceDescriptor`. Returning the wrong shape was not a visible error
  // here -- the extra `name` was ignored and the missing `label` reached the
  // dialog as `undefined` -- so the screenshots this harness exists to produce
  // showed a device select with no device names in it.
  list_microphones: () => [
    { label: "Fake Microphone", isDefault: true, caution: false },
    { label: "Fake Headset", isDefault: false, caution: false },
  ],
  get_microphone_permission_status: () => ({ state: "authorized" }),
  check_microphone_permission: () => ({ state: "authorized" }),
  request_microphone_permission: () => ({ state: "authorized" }),
  // Preference persistence goes through the real repository, so the harness
  // has to answer the real storage commands or a toggle would appear to work
  // while silently failing. The stored blob is kept in one variable and handed
  // back on read, which is what the native side does.
  // The repository merges a row keyed by userId, so the fake row must carry one
  // or the first write fails on a null row.
  user_preferences_get: () =>
    storedPreferences
      ? { ...(storedPreferences as object), userId: "harness-user" }
      : null,
  user_preferences_set: (args) => {
    storedPreferences = args.preferences;
    return { ...(args.preferences as object), userId: "harness-user" };
  },
  "plugin:log|log": () => null,
  "plugin:event|emit": () => null,
  "plugin:event|listen": () => 0,
  "plugin:event|unlisten": () => null,
};

(globalThis as any).__stats = stats;
(globalThis as any).__unhandled = unhandled;
(window as any).__TAURI_INTERNALS__ = {
  // The settings dialog only ever lives in the main window, and the local-data
  // write gate refuses writes from any other label. Labelling it anything else
  // would make the harness test a window the feature is never shown in.
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
  invoke: (cmd: string, args: any) => {
    const handler = handlers[cmd];
    if (!handler) {
      unhandled.add(cmd);
      // Every unmapped command is recorded and rejected, so a gap fails loudly
      // in the probe output instead of silently returning undefined. Rejection
      // rather than a synchronous throw, because the real `invoke` always
      // returns a promise and a caller is entitled to rely on that.
      return Promise.reject(new Error(`harness: no fake for command "${cmd}"`));
    }
    return Promise.resolve(handler(args));
  },
};
(globalThis as any).__stats = stats;

const LazyDialog = React.lazy(() =>
  import("@desktop/components/settings/MicrophoneDialog").then((m) => ({
    default: m.MicrophoneDialog,
  })),
);

// The real readiness component owns the device: it is the thing that calls
// warmMicrophone, polls microphoneReady and publishes `microphoneHeld`. Without
// it mounted, the dialog is permanently stuck on "Checking the microphone...",
// which is a state the app itself never stays in.
const LazySideEffects = React.lazy(() =>
  import("@desktop/components/root/MicrophoneReadinessSideEffects").then(
    (m) => ({
      default: m.MicrophoneReadinessSideEffects,
    }),
  ),
);

const LoadedDialog = () => (
  <>
    <LazySideEffects />
    <LazyDialog />
  </>
);

const Main = () => {
  const [ready, setReady] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { setAppState } = await import("@desktop/store");
        const { INITIAL_APP_STATE } = await import("@desktop/state/app.state");
        const { createDefaultPreferences } =
          await import("@desktop/actions/user-actions-core");
        const draft = structuredClone(INITIAL_APP_STATE) as any;
        draft.userPrefs = createDefaultPreferences();
        draft.settings.microphoneDialogOpen = true;
        draft.permissions.microphone = { state: "authorized" };
        setAppState(draft, true);
        setReady(true);
      } catch (error) {
        setErr(String(error));
      }
    })();
  }, []);

  if (err) return <Box sx={{ p: 2 }}>harness error: {err}</Box>;
  if (!ready) return <Box sx={{ p: 2 }}>loading…</Box>;

  return (
    <React.Suspense fallback={<Box sx={{ p: 2 }}>loading dialog…</Box>}>
      <LoadedDialog />
    </React.Suspense>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IntlProvider locale="en" defaultLocale="en" messages={en}>
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        <CssBaseline />
        <Box data-testid="harness-root" sx={{ minHeight: "100vh" }}>
          <Main />
        </Box>
      </ThemeProvider>
    </IntlProvider>
  </React.StrictMode>,
);
