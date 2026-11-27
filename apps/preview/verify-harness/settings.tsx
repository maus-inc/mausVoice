/**
 * Verification harness for the settings surface.
 *
 * Renders the REAL `SettingsLayout` and the REAL pages, inside a stand-in for
 * the app shell that reproduces the one thing the shell contributes to a
 * measurement: the width of the navigation rail and the padding of the routed
 * pane. A screenshot taken here has the same geometry as the shipped window,
 * which is the point: the settings surface can be seen, measured and
 * screenshotted at each window size the app allows, outside the Tauri runtime.
 *
 * Nothing here ships. It exists so layout changes can be checked against
 * rendered pixels rather than against the styles that were meant to produce
 * them.
 *
 * Run the preview app and open
 * `/verify-harness/settings.html?page=<page-id>&theme=<light|dark>`; the page
 * ids are the settings route ids (`home`, `dictation`, `ai-models`,
 * `shortcuts`, `appearance`, `privacy-data`, `system`, `account`).
 *
 * The native bridge is faked at the same seam the WebView uses, the
 * `__TAURI_*_INTERNALS__` objects, so no component is mocked or forked. The OS
 * plugin's internals are part of that seam: the app asks the platform for its
 * name while rendering and never resolves until it gets one.
 *
 * The app state is seeded and empty of user data, which the settings pages do
 * not read. The overview is the exception: its "shortcuts you use most" card
 * shows that it is loading, because nothing has recorded a shortcut in a
 * harness that has never dictated anything.
 */
import "@desktop/styles/fonts.css";
import "@desktop/styles/tokens.css";
import { Box, CssBaseline, Stack, ThemeProvider } from "@mui/material";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { THEME_PROVIDER_CONFIG, theme } from "@desktop/theme";
import { SettingsLayout } from "@desktop/components/settings/SettingsLayout";
import en from "@desktop/i18n/locales/en.json";
import { installFakeTauri } from "./fake-tauri";

/**
 * What the settings surface asks the native side for. It reads the platform
 * while rendering, and it subscribes to the events that report a preference
 * changed elsewhere; everything else is state the harness seeds below.
 */
const ANSWERS: Record<string, unknown> = {
  platform: "macos",
  os_type: "macos",
  listen: 0,
  emit: 0,
};

(window as any).__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: "macos",
  os_type: "macos",
  family: "unix",
  eol: "\n",
  version: "14.0.0",
  arch: "aarch64",
  exe_extension: "",
};

installFakeTauri((cmd) => ANSWERS[cmd.split("|").pop() ?? ""] ?? null);

const params = new URLSearchParams(window.location.search);
const page = params.get("page") ?? "home";
const scheme: "light" | "dark" =
  params.get("theme") === "dark" ? "dark" : "light";

const pages: Record<string, () => Promise<{ default: React.ComponentType }>> = {
  home: () => import("@desktop/components/settings/pages/HomeSettingsPage"),
  dictation: () =>
    import("@desktop/components/settings/pages/DictationSettingsPage"),
  "ai-models": () =>
    import("@desktop/components/settings/pages/AiModelsSettingsPage"),
  shortcuts: () =>
    import("@desktop/components/settings/pages/ShortcutsSettingsPage"),
  appearance: () =>
    import("@desktop/components/settings/pages/AppearanceSettingsPage"),
  "privacy-data": () =>
    import("@desktop/components/settings/pages/PrivacyDataSettingsPage"),
  system: () => import("@desktop/components/settings/pages/SystemSettingsPage"),
  account: () =>
    import("@desktop/components/settings/pages/AccountSettingsPage"),
};

/**
 * A page from the lazy routes, imported on demand like the app's own routes so
 * the harness adds no more to first paint than the shipped menu entry does.
 */
const LazyPage = ({ id }: { id: string }) => {
  const [Page, setPage] = useState<React.ComponentType | null>(null);
  useEffect(() => {
    void pages[id]().then((module) => setPage(() => module.default));
  }, [id]);
  return Page ? <Page /> : null;
};

const App = () => {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { setAppState } = await import("@desktop/store");
        const { INITIAL_APP_STATE } = await import("@desktop/state/app.state");
        const { createDefaultPreferences } =
          await import("@desktop/actions/user-actions-core");
        const state = structuredClone(INITIAL_APP_STATE) as any;
        state.userPrefs = createDefaultPreferences();
        state.settings.apiKeysStatus = "success";
        state.hotkeyStrategy = "listener";
        state.keyboardListenerHealth = "healthy";
        setAppState(state, true);
        setReady(true);
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, []);

  if (error) {
    return <Box sx={{ p: 2 }}>harness error: {error}</Box>;
  }
  if (!ready) {
    return <Box sx={{ p: 2 }}>loading settings…</Box>;
  }

  return (
    <MemoryRouter initialEntries={[`/dashboard/settings/${page}`]}>
      <Stack
        direction="row"
        sx={{ height: "100vh", width: "100%", overflow: "hidden" }}
      >
        {/* The app's navigation rail, reduced to the width it takes before the
            routed pane starts. Its own contents are irrelevant to a settings
            measurement; its 232px are not. */}
        <Box
          aria-hidden
          sx={{
            display: { xs: "none", sm: "block" },
            width: 232,
            flexShrink: 0,
          }}
        />
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            p: { xs: 1, sm: 1.5 },
            pt: { xs: 0.5, sm: 1 },
          }}
        >
          <Box sx={{ flexGrow: 1, minHeight: 0, overflow: "auto" }}>
            <Routes>
              <Route path="/dashboard/settings" element={<SettingsLayout />}>
                <Route
                  index
                  element={<Navigate to="/dashboard/settings/home" replace />}
                />
                {Object.keys(pages).map((id) => (
                  <Route key={id} path={id} element={<LazyPage id={id} />} />
                ))}
              </Route>
            </Routes>
          </Box>
        </Box>
      </Stack>
    </MemoryRouter>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IntlProvider locale="en" defaultLocale="en" messages={en}>
      <ThemeProvider
        theme={theme}
        {...THEME_PROVIDER_CONFIG}
        defaultMode={scheme}
      >
        <CssBaseline />
        <App />
      </ThemeProvider>
    </IntlProvider>
  </React.StrictMode>,
);
