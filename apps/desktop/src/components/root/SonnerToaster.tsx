import GlobalStyles from "@mui/material/GlobalStyles";
import { Toaster } from "sonner";

/**
 * mui-treasury `@mui-treasury/sonner` theme bridge, adapted to cssVarPrefix `app`.
 * Maps sonner CSS variables onto the MUI palette so toasts follow cream/onyx.
 */
export const SonnerToaster = () => {
  return (
    <>
      <GlobalStyles
        styles={(theme) => ({
          "[data-sonner-toaster]": {
            "--normal-bg": `${theme.vars.palette.background.paper} !important`,
            "--normal-border": `${theme.vars.palette.divider} !important`,
            "--normal-text": `${theme.vars.palette.text.primary} !important`,
            "--success-bg": `${theme.vars.palette.level2} !important`,
            "--success-border": `${theme.vars.palette.divider} !important`,
            "--success-text": `${theme.vars.palette.text.primary} !important`,
            "--error-bg": `${theme.vars.palette.error.main} !important`,
            "--error-border": `${theme.vars.palette.error.dark} !important`,
            "--error-text": `${theme.vars.palette.error.contrastText} !important`,
            "--border-radius": `${theme.shape.borderRadius}px !important`,
            fontFamily: `${theme.typography.fontFamily} !important`,
          },
          "[data-sonner-toast]": {
            boxShadow: "none !important",
          },
          "[data-sonner-toast] [data-title]": {
            fontWeight: `${theme.typography.fontWeightMedium} !important`,
          },
        })}
      />
      <Toaster richColors position="bottom-right" duration={4000} closeButton />
    </>
  );
};
