/**
 * Source: siriwatknp/mui-treasury
 * apps/website/registry/components/sonner/sonner.tsx
 * Adapted for cssVarPrefix "app" (theme.vars always present).
 *
 * Restyled from the stock `richColors` look: non-critical confirmations
 * (copy, export, delete) should read as one quiet surface with a
 * status-coloured icon — same hairline + premium lift as popovers and
 * dialogs — instead of saturated colour blocks that fight the palette.
 * (Toast UX research: keep low-priority toasts neutral; let the icon carry
 * the status.) Sonner type icons are `fill="currentColor"`, so colouring
 * `[data-icon]` per `data-type` is enough.
 */
import GlobalStyles from "@mui/material/GlobalStyles";
import { Toaster } from "sonner";

import { accent } from "../../styles/palette";
import { duration } from "../../styles/motion";
import { hairline, premiumSurface } from "../../styles/shadows";

export { toast } from "sonner";

export const SonnerToaster = () => {
  return (
    <>
      <GlobalStyles
        styles={(theme) => ({
          "[data-sonner-toaster]": {
            // One surface for every type: status is signalled by the icon
            // and the copy, not by the background.
            "--normal-bg": `${theme.vars.palette.background.paper} !important`,
            "--normal-border": `${theme.vars.palette.divider} !important`,
            "--normal-text": `${theme.vars.palette.text.primary} !important`,
            "--border-radius": `${theme.shape.borderRadius}px !important`,
            fontFamily: `${theme.typography.fontFamily} !important`,
          },
          "[data-sonner-toast][data-styled='true']": {
            padding: "12px 14px !important",
            fontSize: `${theme.typography.pxToRem(13.5)} !important`,
            border: `${hairline.light(0.08)} !important`,
            boxShadow: `${premiumSurface.light.hover} !important`,
            ...theme.applyStyles("dark", {
              border: `${hairline.dark(0.08)} !important`,
              boxShadow: `${premiumSurface.dark.hover} !important`,
            }),
          },
          "[data-sonner-toast][data-type='success'] [data-icon]": {
            color: `${theme.vars.palette.success.main} !important`,
          },
          "[data-sonner-toast][data-type='error'] [data-icon]": {
            color: `${theme.vars.palette.error.main} !important`,
          },
          "[data-sonner-toast][data-type='warning'] [data-icon]": {
            color: `${theme.vars.palette.warning.main} !important`,
          },
          "[data-sonner-toast][data-type='info'] [data-icon]": {
            color: `${theme.vars.palette.info.main} !important`,
          },
          "[data-sonner-toast] [data-title]": {
            fontWeight: `${theme.typography.fontWeightMedium} !important`,
          },
          "[data-sonner-toast] [data-description]": {
            color: `${theme.vars.palette.text.secondary} !important`,
          },
          // Action (e.g. Undo): quiet chip raised one tier above the card,
          // not sonner's inverted white-on-black slab.
          "[data-sonner-toast][data-styled='true'] [data-button]": {
            background: `${theme.vars.palette.level2} !important`,
            color: `${theme.vars.palette.text.primary} !important`,
            border: `${hairline.light(0.06)} !important`,
            borderRadius: "8px !important",
            fontWeight: `${theme.typography.fontWeightMedium} !important`,
            transition: `background-color ${duration.exit}s !important`,
            "&:hover": {
              background: `${theme.vars.palette.level3} !important`,
            },
            ...theme.applyStyles("dark", {
              border: `${hairline.dark(0.06)} !important`,
            }),
          },
          // Close: tone-on-tone disc instead of the stock grey-bordered dot.
          "[data-sonner-toast][data-styled='true'] [data-close-button]": {
            background: `${theme.vars.palette.background.paper} !important`,
            border: `${hairline.light(0.1)} !important`,
            color: `${theme.vars.palette.text.secondary} !important`,
            boxShadow: `${premiumSurface.light.rest} !important`,
            "&:hover": {
              background: `${theme.vars.palette.level1} !important`,
              color: `${theme.vars.palette.text.primary} !important`,
              border: `${hairline.light(0.16)} !important`,
            },
            ...theme.applyStyles("dark", {
              border: `${hairline.dark(0.1)} !important`,
              boxShadow: `${premiumSurface.dark.rest} !important`,
              "&:hover": {
                border: `${hairline.dark(0.16)} !important`,
              },
            }),
          },
          // Focus ring in the app accent, not the stock grey halo.
          "[data-sonner-toast][data-styled='true']:focus-visible": {
            boxShadow: `${premiumSurface.light.hover}, 0 0 0 2px rgba(${accent.light.rgb}, 0.5) !important`,
            ...theme.applyStyles("dark", {
              boxShadow: `${premiumSurface.dark.hover}, 0 0 0 2px rgba(${accent.dark.rgb}, 0.5) !important`,
            }),
          },
        })}
      />
      <Toaster position="bottom-right" duration={4000} closeButton />
    </>
  );
};
