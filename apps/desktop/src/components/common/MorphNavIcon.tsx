import { Box } from "@mui/material";
import type { IconNode } from "lucide";
import { MorphIcon } from "morphicons/react";
import { useMemo } from "react";

type MorphNavIconProps = {
  icon: IconNode;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

/**
 * Level-4 icon surface: morphicons spring morph when the icon node changes.
 * Used for sidebar / header glyphs that swap state.
 */
export const MorphNavIcon = ({
  icon,
  size = 22,
  color = "currentColor",
  strokeWidth = 1.85,
}: MorphNavIconProps) => {
  const node = useMemo(() => icon, [icon]);
  return (
    <Box
      sx={{
        display: "inline-flex",
        width: size,
        height: size,
        color: "inherit",
        "& svg": { display: "block" },
      }}
    >
      <MorphIcon
        icon={node}
        size={size}
        color={color}
        strokeWidth={strokeWidth}
        spring="snappy"
      />
    </Box>
  );
};
