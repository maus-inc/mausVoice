/**
 * Source: siriwatknp/mui-treasury
 * apps/website/registry/components/keycap-01/keycap-01.tsx
 * Sized down for in-row badges (min 22 vs demo 64).
 */
import ButtonBase, { type ButtonBaseProps } from "@mui/material/ButtonBase";

export type KeycapProps = Omit<ButtonBaseProps, "disableRipple">;

export function Keycap({ sx, children, ...props }: KeycapProps) {
  return (
    <ButtonBase
      disableRipple
      sx={[
        (theme) => ({
          minWidth: 22,
          minHeight: 22,
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
            "inset 0 1px 0 rgba(255,255,255,0.7)",
            "inset 0 -2px 0 rgba(26,23,18,0.1)",
            "0 1px 0 rgba(26,23,18,0.06)",
          ].join(", "),
          "&:active": {
            transform: "translateY(2px)",
            boxShadow: [
              "inset 0 1px 0 rgba(255,255,255,0.7)",
              "inset 0 -1px 0 rgba(26,23,18,0.1)",
            ].join(", "),
          },
          ...theme.applyStyles("dark", {
            boxShadow: [
              "inset 0 1px 0 rgba(255,255,255,0.08)",
              "inset 0 -2px 0 rgba(0,0,0,0.45)",
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
