/**
 * Source: siriwatknp/mui-treasury
 * apps/website/registry/components/keycap-01/keycap-01.tsx
 * Sized down for in-row badges (min 22 vs demo 64).
 */
import ButtonBase, { type ButtonBaseProps } from "@mui/material/ButtonBase";
import { darkInk, highlight, ink } from "../../styles/palette";

export type KeycapProps = Omit<ButtonBaseProps, "disableRipple">;

export function Keycap({ sx, children, ...props }: KeycapProps) {
  return (
    <ButtonBase
      disableRipple
      sx={[
        (theme) => ({
          minWidth: 22,
          minHeight: 22,
          // A keycap's own invariant: its box is never narrower than its label,
          // so text can never spill past the painted cap. minWidth replaces the
          // flexbox automatic minimum size, which is what makes this needed at
          // all. HotkeyBadge's flexWrap is what makes the invariant hold for
          // today's consumers, since line breaking uses hypothetical sizes and
          // never compresses a line. This keeps it true regardless, because a
          // caller can override that wrap through HotkeyBadge's sx.
          flexShrink: 0,
          px: 0.75,
          py: 0.25,
          borderRadius: 0.5,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.75rem",
          fontWeight: 650,
          lineHeight: 1,
          color: "text.primary",
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: 2,
          },
          backgroundColor: theme.vars.palette.level1,
          boxShadow: [
            `inset 0 1px 0 ${highlight(0.7)}`,
            `inset 0 -2px 0 ${ink(0.1)}`,
            `0 1px 0 ${ink(0.06)}`,
          ].join(", "),
          "&:active": {
            transform: "translateY(2px)",
            boxShadow: [
              `inset 0 1px 0 ${highlight(0.7)}`,
              `inset 0 -1px 0 ${ink(0.1)}`,
            ].join(", "),
          },
          ...theme.applyStyles("dark", {
            boxShadow: [
              `inset 0 1px 0 ${highlight(0.08)}`,
              `inset 0 -2px 0 ${darkInk(0.45)}`,
            ].join(", "),
            "&:active": {
              transform: "translateY(2px)",
            },
          }),
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...props}
    >
      {children}
    </ButtonBase>
  );
}
