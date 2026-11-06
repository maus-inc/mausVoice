import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { StrictMode, useMemo, type ReactNode } from "react";
import { IntlProvider } from "react-intl";
import { getIntlConfig } from "../../i18n";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";

/** Shared theme and localization for the desktop and its browser preview. */
export const AppProviders = ({ children }: { children: ReactNode }) => {
  const intlConfig = useMemo(() => getIntlConfig(), []);
  return (
    <StrictMode>
      <IntlProvider {...intlConfig}>
        <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </IntlProvider>
    </StrictMode>
  );
};
