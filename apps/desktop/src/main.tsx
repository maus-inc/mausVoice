import "./styles/fonts.css";
import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { FirebaseOptions, initializeApp } from "firebase/app";
import mixpanel from "mixpanel-browser";
import { connectAuthEmulator } from "firebase/auth";
import { connectDatabaseEmulator, getDatabase } from "firebase/database";
import React, { useEffect, useMemo } from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { AppWithLoading } from "./components/root/AppWithLoading";
import { SnackbarEmitter } from "./components/root/SnackbarEmitter";
import { getIntlConfig } from "./i18n";
import { theme } from "./theme";
import { createEffectiveAuth } from "./utils/auth.utils";
import { applyDomMutationGuards } from "./utils/dom-guard.utils";
import { getIsEmulators } from "./utils/env.utils";

// WebView2/Chrome page tooling (e.g. translation) can reparent text nodes that
// React owns; guard the DOM mutators before the root renders, or one such
// mutation kills the whole UI on the next navigation.
applyDomMutationGuards();

const firebaseConfig: FirebaseOptions = {
  apiKey:
    import.meta.env.VITE_FIREBASE_API_KEY ||
    "AIzaSyCJ8C3ZW2bHjerneg5i0fr-b5uwuy7uULM",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
    "mausvoice-dev.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "mausvoice-dev",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
    "mausvoice-dev.firebasestorage.app",
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "778214168359",
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ||
    "1:778214168359:web:66ee2ce5df76c8c2d77b02",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-V6Y1RSFBQX",
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL ||
    "https://mausvoice-prod-default-rtdb.firebaseio.com",
};

const missingFirebaseConfigKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseConfigKeys.length > 0) {
  throw new Error(
    `Missing Firebase configuration values: ${missingFirebaseConfigKeys.join(", ")}`,
  );
}

const app = initializeApp(firebaseConfig);

const auth = createEffectiveAuth(app);
if (getIsEmulators()) {
  connectAuthEmulator(auth, `http://localhost:9099`);
}

const database = getDatabase(app);
if (getIsEmulators()) {
  connectDatabaseEmulator(database, "localhost", 9000);
}

const mixpanelToken = import.meta.env.VITE_MIXPANEL_TOKEN;
if (mixpanelToken) {
  mixpanel.init(mixpanelToken, {
    debug: import.meta.env.DEV,
    track_pageview: false,
    persistence: "localStorage",
  });
}

const rootElement = document.getElementById("root") as HTMLElement;

// Prevent HMR from creating multiple React roots.
// Store the root on the DOM element so we can reuse it across hot reloads.
const existingRoot = (rootElement as unknown as { _reactRoot?: ReactDOM.Root })
  ._reactRoot;
const root = existingRoot ?? ReactDOM.createRoot(rootElement);
(rootElement as unknown as { _reactRoot?: ReactDOM.Root })._reactRoot = root;

type ChildrenProps = {
  children: React.ReactNode;
};

const Main = ({ children }: ChildrenProps) => {
  const intlConfig = useMemo(() => getIntlConfig(), []);

  // The pre-hydration script in index.html paints the launch canvas via
  // body.boot-theme-{light,dark} classes. Clear them as soon as React mounts
  // so MUI's CssBaseline (theme.vars.palette.level0) owns the body background
  // from then on. Leaving the classes in place would keep an !important rule
  // pinned to the launch-time scheme — that is what made light mode look
  // hardcoded to dark.
  useEffect(() => {
    document.body.classList.remove("boot-theme-light", "boot-theme-dark");
  }, []);

  return (
    <React.StrictMode>
      <IntlProvider {...intlConfig}>
        <ThemeProvider
          theme={theme}
          defaultMode="system"
          colorSchemeStorageKey="mode"
        >
          <CssBaseline />
          {children}
        </ThemeProvider>
      </IntlProvider>
    </React.StrictMode>
  );
};

root.render(
  <Main>
    <SnackbarEmitter />
    <AppWithLoading />
  </Main>,
);
