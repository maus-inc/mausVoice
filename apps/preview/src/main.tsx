/** Preview entry — mirrors the desktop provider stack (Intl + real theme)
 *  then adds the spec-override layers (derived theme + CSS vars). */
import "./preview.css";
import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import React from "react";
import ReactDOM from "react-dom/client";
import { IntlProvider } from "react-intl";
import { THEME_PROVIDER_CONFIG, theme } from "@desktop/theme";
import { ContextMenuProvider } from "@desktop/components/common/ContextMenu";
import { App } from "./App";
import { PaletteOverrideStyle, PatchedThemeProvider, SpecProvider } from "./lib/spec-store";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IntlProvider locale="en" defaultLocale="en" messages={{}}>
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        <CssBaseline />
        <SpecProvider>
          <PaletteOverrideStyle />
          <PatchedThemeProvider>
            <ContextMenuProvider>
              <App />
            </ContextMenuProvider>
          </PatchedThemeProvider>
        </SpecProvider>
      </ThemeProvider>
    </IntlProvider>
  </React.StrictMode>,
);
