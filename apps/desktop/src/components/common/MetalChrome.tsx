import { useColorScheme } from "@mui/material";
import { useReducedMotion } from "framer-motion";
import { MetalFx, type MetalFxProps } from "metal-fx";

/**
 * Jakub Antalík metal-fx (metal.jakubantalik.com) — silver liquid-metal ring.
 * Theme follows the app scheme, not OS auto. Reduced motion freezes the shader.
 */
export const MetalChrome = ({
  children,
  variant = "button",
  ...rest
}: MetalFxProps) => {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? systemMode : mode;
  const reduceMotion = useReducedMotion();

  return (
    <MetalFx
      preset="silver"
      theme={resolved === "light" ? "light" : "dark"}
      strength={0.55}
      paused={!!reduceMotion}
      variant={variant}
      {...rest}
    >
      {children}
    </MetalFx>
  );
};
