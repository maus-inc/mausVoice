import { Stack } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { getPrettyKeyName } from "../../utils/keyboard.utils";
import { Keycap } from "./Keycap";

type HotkeyBadgeProps = {
  keys: string[];
  onClick?: () => void;
  sx?: SxProps<Theme>;
};

export const HotkeyBadge = ({ keys, onClick, sx }: HotkeyBadgeProps) => {
  const comboLabel = keys.map(getPrettyKeyName).join(" + ");

  return (
    <Stack
      component={onClick ? "button" : "div"}
      direction="row"
      spacing={0.5}
      aria-label={comboLabel}
      role={onClick ? undefined : "group"}
      onClick={onClick}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        ...(onClick
          ? {
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
            }
          : {}),
        ...sx,
      }}
    >
      {keys.map((key, index) => (
        <Keycap
          key={`${key}-${index}`}
          component={onClick ? "span" : undefined}
          tabIndex={-1}
          aria-hidden
        >
          {getPrettyKeyName(key)}
        </Keycap>
      ))}
    </Stack>
  );
};
