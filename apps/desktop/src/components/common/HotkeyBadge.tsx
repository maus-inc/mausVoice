import { ButtonBase, Stack } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { highlight, ink } from "../../styles/palette";
import { getPrettyKeyName } from "../../utils/keyboard.utils";

type HotkeyBadgeProps = {
  keys: string[];
  onClick?: () => void;
  sx?: SxProps<Theme>;
};

/**
 * Machined keycap chips (mui-treasury keycap-01 pattern): each key is its own
 * ButtonBase cap with press translate and a designed focus ring.
 */
export const HotkeyBadge = ({ keys, onClick, sx }: HotkeyBadgeProps) => {
  const clickable = Boolean(onClick);

  return (
    <Stack
      direction="row"
      spacing={0.5}
      component={clickable ? ButtonBase : "span"}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      aria-label={keys.map(getPrettyKeyName).join(" + ")}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 0.5,
        ...(clickable && { cursor: "pointer" }),
        ...sx,
      }}
    >
      {keys.map((key, index) => (
        <Stack
          key={`${key}-${index}`}
          component="kbd"
          sx={{
            minWidth: 22,
            px: 0.75,
            py: 0.25,
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.75rem",
            fontWeight: 650,
            lineHeight: 1.3,
            borderRadius: 0.5,
            bgcolor: (theme) => theme.vars?.palette.level1,
            border: "1px solid",
            borderColor: "divider",
            boxShadow: (theme) =>
              theme.palette.mode === "dark"
                ? `inset 0 1px 0 ${highlight(0.12)}, 0 2px 0 ${ink(0.45)}`
                : `inset 0 1px 0 ${highlight(0.7)}, 0 2px 0 ${ink(0.12)}`,
            "&:active": clickable ? { transform: "translateY(2px)" } : undefined,
          }}
        >
          {getPrettyKeyName(key)}
        </Stack>
      ))}
    </Stack>
  );
};
