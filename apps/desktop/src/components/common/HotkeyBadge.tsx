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
  const occurrences = new Map<string, number>();
  const keycaps = keys.map((key) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { key, identity: `${key}:${occurrence}` };
  });

  // Caps are always `span`, in both modes. `Keycap` is a `ButtonBase`, whose
  // default element is a native `<button>`, so a read-only badge used to render
  // each cap as a focusable control carrying no name of its own (`aria-hidden`,
  // `tabIndex={-1}`) inside a `role="group"`. Hidden interactive controls are
  // what the override was there to avoid in the clickable case, so it applies
  // unconditionally.
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
      {keycaps.map(({ key, identity }) => (
        <Keycap key={identity} component="span" tabIndex={-1} aria-hidden>
          {getPrettyKeyName(key)}
        </Keycap>
      ))}
    </Stack>
  );
};
