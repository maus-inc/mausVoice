/**
 * Source: siriwatknp/mui-treasury
 * apps/website/registry/components/sonner/sonner.tsx
 * Adapted only for cssVarPrefix "app" (theme.vars always present).
 */
import GlobalStyles from "@mui/material/GlobalStyles";
import { Toaster } from "sonner";

export { toast } from "sonner";

export const SonnerToaster = () => {
  return (
    <>
      <GlobalStyles
        styles={(theme) => ({
          "[data-sonner-toaster]": {
            "--normal-bg": `${theme.vars.palette.background.paper} !important`,
            "--normal-border": `${theme.vars.palette.divider} !important`,
            "--normal-text": `${theme.vars.palette.text.primary} !important`,
            "--success-bg": `${theme.vars.palette.success.main} !important`,
            "--success-border": `${theme.vars.palette.success.dark} !important`,
            "--success-text": `${theme.vars.palette.success.contrastText} !important`,
            "--error-bg": `${theme.vars.palette.error.main} !important`,
            "--error-border": `${theme.vars.palette.error.dark} !important`,
            "--error-text": `${theme.vars.palette.error.contrastText} !important`,
            "--warning-bg": `${theme.vars.palette.warning.main} !important`,
            "--warning-border": `${theme.vars.palette.warning.dark} !important`,
            "--warning-text": `${theme.vars.palette.warning.contrastText} !important`,
            "--info-bg": `${theme.vars.palette.info.main} !important`,
            "--info-border": `${theme.vars.palette.info.dark} !important`,
            "--info-text": `${theme.vars.palette.info.contrastText} !important`,
            "--border-radius": `${theme.shape.borderRadius}px !important`,
            fontFamily: `${theme.typography.fontFamily} !important`,
          },
          "[data-sonner-toast] [data-title]": {
            fontWeight: `${theme.typography.fontWeightMedium} !important`,
          },
          "[data-sonner-toast] [data-description]": {
            color: `${theme.vars.palette.text.secondary} !important`,
          },
        })}
      />
      <Toaster richColors position="bottom-right" duration={4000} closeButton />
    </>
  );
};
