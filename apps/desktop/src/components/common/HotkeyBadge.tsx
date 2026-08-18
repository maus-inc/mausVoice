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
  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{ display: "inline-flex", alignItems: "center", ...sx }}
    >
      {keys.map((key, index) => (
        <Keycap
          key={`${key}-${index}`}
          onClick={onClick}
          aria-label={keys.map(getPrettyKeyName).join(" + ")}
        >
          {getPrettyKeyName(key)}
        </Keycap>
      ))}
    </Stack>
  );
};
