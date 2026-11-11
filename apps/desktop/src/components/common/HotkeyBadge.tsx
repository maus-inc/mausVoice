import { Stack } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { keycapDashboardSize } from "../../styles/keycap";
import { getKeycapLegend, getPrettyKeyName } from "../../utils/keyboard.utils";
import { Keycap } from "./Keycap";
import { Keycap3d } from "./Keycap3d";
import { keycapIdentities } from "./keycap-identities";

type HotkeyBadgeProps = {
  keys: string[];
  onClick?: () => void;
  appearance?: "classic" | "3d";
  sx?: SxProps<Theme>;
};

export const HotkeyBadge = ({
  keys,
  onClick,
  appearance = "classic",
  sx,
}: HotkeyBadgeProps) => {
  const comboLabel = keys.map(getPrettyKeyName).join(" + ");
  const keycaps = keycapIdentities(keys);

  // Keycaps are decorative spans; the enclosing badge supplies the name and,
  // when clickable, the only interactive control.
  return (
    <Stack
      component={onClick ? "button" : "div"}
      type={onClick ? "button" : undefined}
      direction="row"
      spacing={0.5}
      aria-label={comboLabel}
      role={onClick ? undefined : "group"}
      onClick={onClick}
      sx={[
        {
          display: "inline-flex",
          alignItems: "center",
          // Caps never shrink, so without this a long combo stays one wide
          // unbreakable box and overflows whatever inline row or tooltip
          // bubble holds it, where a pane clip can cut the last cap in half.
          // Wrapping here keeps the badge's width down to its widest single cap.
          flexWrap: "wrap",
          ...(onClick
            ? {
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
              }
            : {}),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {keycaps.map(({ key, identity }) =>
        // Long legends become unreadable on the fixed-size rendered face.
        appearance === "3d" && getKeycapLegend(key).label.length <= 4 ? (
          <span
            key={identity}
            aria-hidden="true"
            style={{ display: "inline-flex" }}
          >
            <Keycap3d
              {...getKeycapLegend(key)}
              view="front"
              size={keycapDashboardSize}
            />
          </span>
        ) : (
          <Keycap key={identity} aria-hidden>
            {getPrettyKeyName(key)}
          </Keycap>
        ),
      )}
    </Stack>
  );
};
