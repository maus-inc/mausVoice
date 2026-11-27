/**
 * Verification harness for `HelpPage`, sibling dashboard pages, and live
 * `TipCard` rendering inside the real desktop shell geometry.
 *
 * Query parameters:
 * - `view`: `help` (default) | `dictionary` | `apps` | `live-tip`
 * - `theme`: `light` (default) | `dark`
 * - `dismissed`: comma-separated tip ids (default `writing-styles,update-channel`), or `none` / `all`
 * - `assistant`: `off` (default) | `on`
 */
import "@desktop/styles/fonts.css";
import "@desktop/styles/tokens.css";
import { Box, CssBaseline, Stack, ThemeProvider } from "@mui/material";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import AppsPage from "@desktop/components/apps/AppsPage";
import { DashboardMenu } from "@desktop/components/dashboard/DashboardMenu";
import DictionaryPage from "@desktop/components/dictionary/DictionaryPage";
import HelpPage from "@desktop/components/help/HelpPage";
import { TipCard } from "@desktop/components/onboarding/TipCard";
import { setTipAction } from "@desktop/components/onboarding/tip-actions";
import en from "@desktop/i18n/locales/en.json";
import { THEME_PROVIDER_CONFIG, theme } from "@desktop/theme";
import { ONBOARDING_TIPS, type OnboardingTipId } from "@desktop/utils/tips";
import { installFakeTauri } from "./fake-tauri";

type HarnessWindow = Window & {
  __TAURI_OS_PLUGIN_INTERNALS__?: Record<string, string>;
  __HELP_NAV_LOG__?: string[];
  __TIP_LIVE_ACTION_CLICKS__?: string[];
};

const harnessWindow = window as HarnessWindow;

const NATIVE_ANSWERS: Record<string, unknown> = {
  platform: "macos",
  os_type: "macos",
  version: "0.1.6",
  listen: 0,
  emit: 0,
  term_find_many: [],
};

harnessWindow.__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: "macos",
  os_type: "macos",
  family: "unix",
  eol: "\n",
  version: "14.0.0",
  arch: "aarch64",
  exe_extension: "",
};

installFakeTauri((cmd) => NATIVE_ANSWERS[cmd.split("|").pop() ?? ""] ?? null);

const params = new URLSearchParams(window.location.search);
const activeView = params.get("view") ?? "help";
const colorScheme: "light" | "dark" =
  params.get("theme") === "dark" ? "dark" : "light";
const assistantEnabled = params.get("assistant") === "on";

const parseDismissedIds = (): OnboardingTipId[] => {
  const raw = params.get("dismissed");
  if (raw === "none") return [];
  if (raw === "all") return ONBOARDING_TIPS.map((tip) => tip.id);
  if (!raw) return ["writing-styles", "update-channel"];
  const validIds = new Set<string>(ONBOARDING_TIPS.map((tip) => tip.id));
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id): id is OnboardingTipId => validIds.has(id));
};

const seedHarnessStore = async (): Promise<void> => {
  const [{ setAppState }, { INITIAL_APP_STATE }, { createDefaultPreferences }] =
    await Promise.all([
      import("@desktop/store"),
      import("@desktop/state/app.state"),
      import("@desktop/actions/user-actions-core"),
    ]);

  const nextState = structuredClone(INITIAL_APP_STATE);
  const prefs = createDefaultPreferences();
  prefs.agentMode = assistantEnabled ? "api" : "none";
  nextState.userPrefs = prefs;
  nextState.local.assistantModeEnabled = assistantEnabled;
  nextState.local.dismissedTipIds =
    activeView === "live-tip" ? [] : parseDismissedIds();
  nextState.termById = {
    "term-1": {
      id: "term-1",
      createdAt: "2026-11-26T10:00:00.000Z",
      sourceValue: "mausVoice",
      destinationValue: "",
      isReplacement: false,
    },
    "term-2": {
      id: "term-2",
      createdAt: "2026-11-26T09:00:00.000Z",
      sourceValue: "Satoshi",
      destinationValue: "Satoshi",
      isReplacement: true,
    },
  };
  nextState.dictionary.termIds = ["term-1", "term-2"];
  setAppState(nextState, true);
};

const RouteTracker = () => {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    const log = (harnessWindow.__HELP_NAV_LOG__ ??= []);
    log.push(`${pathname}${search}${hash}`);
  }, [pathname, search, hash]);
  return null;
};

const RouteTarget = () => {
  const { pathname, hash } = useLocation();
  const landed = `${pathname}${hash}`;
  return (
    <Box data-route-landed={landed} sx={{ p: 3 }}>
      {landed}
    </Box>
  );
};

const LiveTipStage = () => {
  useEffect(() => {
    return setTipAction("generative-provider", () => {
      const clicks = (harnessWindow.__TIP_LIVE_ACTION_CLICKS__ ??= []);
      clicks.push("generative-provider");
    });
  }, []);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: "level0",
        p: 4,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
      }}
    >
      <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
        <TipCard id="generative-provider" />
        <TipCard id="review-before-insert" />
      </Stack>
    </Box>
  );
};

const routeForView = (viewName: string): string => {
  if (viewName === "dictionary") return "/dashboard/dictionary";
  if (viewName === "apps") return "/dashboard/apps";
  return "/dashboard/help";
};

const DashboardShell = () => (
  <MemoryRouter initialEntries={[routeForView(activeView)]}>
    <RouteTracker />
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "minmax(0, 1fr)",
          sm: "232px minmax(0, 1fr)",
        },
        height: "100vh",
        width: "100%",
        overflow: "hidden",
        bgcolor: "level0",
      }}
    >
      <Box
        component="aside"
        sx={{
          display: { xs: "none", sm: "flex" },
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <DashboardMenu />
      </Box>
      <Box
        sx={{
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          p: { xs: 1, sm: 1.5 },
          pt: { xs: 0.5, sm: 1 },
        }}
      >
        <Box
          component="main"
          sx={{ flexGrow: 1, minHeight: 0, overflow: "auto" }}
        >
          <Routes>
            <Route path="/dashboard/help" element={<HelpPage />} />
            <Route path="/dashboard/dictionary" element={<DictionaryPage />} />
            <Route path="/dashboard/apps" element={<AppsPage />} />
            <Route path="*" element={<RouteTarget />} />
          </Routes>
        </Box>
      </Box>
    </Box>
  </MemoryRouter>
);

const HelpHarness = () => {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void seedHarnessStore()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <Box sx={{ p: 2 }}>harness error: {error}</Box>;
  if (!ready) return <Box sx={{ p: 2 }}>loading help…</Box>;

  if (activeView === "live-tip") {
    return (
      <MemoryRouter initialEntries={["/dashboard/settings/ai-models"]}>
        <LiveTipStage />
      </MemoryRouter>
    );
  }
  return <DashboardShell />;
};

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <IntlProvider locale="en" defaultLocale="en" messages={en}>
        <ThemeProvider
          theme={theme}
          {...THEME_PROVIDER_CONFIG}
          defaultMode={colorScheme}
        >
          <CssBaseline />
          <HelpHarness />
        </ThemeProvider>
      </IntlProvider>
    </React.StrictMode>,
  );
}
