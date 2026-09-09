import { useColorScheme, useTheme } from "@mui/material";
import { useReducedMotion } from "framer-motion";
import { MetalFx, type MetalFxProps } from "metal-fx";

/**
 * Quiet silver ring — watermelon hairline energy, not a full liquid-metal demo.
 * Glow off, low strength; reduced motion freezes the shader.
 */
export const MetalChrome = ({
  children,
  variant = "button",
  ...rest
}: MetalFxProps) => {
  const { mode, systemMode } = useColorScheme();
  const theme = useTheme();
  const resolved =
    (mode === "system" ? systemMode : mode) ?? theme.palette.mode;
  const reduceMotion = useReducedMotion();

  return (
    <MetalFx
      preset="silver"
      theme={resolved === "light" ? "light" : "dark"}
      strength={0.22}
      glowGain={0}
      disableGlow
      paused={Boolean(reduceMotion)}
      variant={variant}
      {...rest}
    >
      {children}
    </MetalFx>
  );
};
