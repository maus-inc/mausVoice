import "../styles/fonts.css";
import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { getIntlConfig } from "../i18n";
import { THEME_PROVIDER_CONFIG, theme } from "../theme";
import { applyDomMutationGuards } from "../utils/dom-guard.utils";
import {
  installGlobalErrorOverlay,
  paintFatalError,
} from "../utils/global-error-overlay.utils";
import { PreviewApp } from "./PreviewApp";
import { applyPreviewScenario, previewScenarioFromLocation } from "./runtime";

installGlobalErrorOverlay();
applyDomMutationGuards();
applyPreviewScenario(previewScenarioFromLocation(window.location));

const rootElement = document.getElementById("root") as HTMLElement;
const existingRoot = (rootElement as unknown as { _reactRoot?: ReactDOM.Root })
  ._reactRoot;
const root = existingRoot ?? ReactDOM.createRoot(rootElement);
(rootElement as unknown as { _reactRoot?: ReactDOM.Root })._reactRoot = root;

const PreviewProviders = ({ children }: { children: React.ReactNode }) => {
  const intlConfig = useMemo(() => getIntlConfig(), []);
  return (
    <React.StrictMode>
      <IntlProvider {...intlConfig}>
        <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </IntlProvider>
    </React.StrictMode>
  );
};

try {
  root.render(
    <PreviewProviders>
      <PreviewApp />
    </PreviewProviders>,
  );
} catch (error) {
  paintFatalError("mausVoice preview failed to start", error);
  throw error;
}
