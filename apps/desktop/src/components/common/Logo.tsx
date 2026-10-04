import { Box, type BoxProps } from "@mui/material";
import appLogo32 from "../../assets/app-logo-32.png";
import appLogo64 from "../../assets/app-logo-64.png";
import appLogo192 from "../../assets/app-logo-192.png";
import { darkInk, highlight } from "../../styles/palette";

export type LogoProps = BoxProps & {
  width?: number | string;
  height?: number | string;
};

export const Logo = ({
  sx,
  width = "2.2rem",
  height = "2.2rem",
  ...rest
}: LogoProps) => {
  // Provide 1x/2x/3x sources so the logo stays sharp at 125%, 150% and 200%
  // Windows display scaling instead of upscaling the source bitmap. `x`
  // descriptors are correct for a fixed-density candidate (the element is
  // sized in CSS px); `sizes` tells the browser that density is what matters.
  const srcSet = `${appLogo32} 1x, ${appLogo64} 2x, ${appLogo192} 3x`;
  const sizes = typeof width === "number" ? `${width}px` : width;

  return (
    <Box
      component="img"
      src={appLogo64}
      srcSet={srcSet}
      sizes={sizes}
      alt="mausVoice"
      draggable={false}
      sx={[
        {
          width: width,
          height: height,
        },
        {
          display: "block",
          objectFit: "contain",
          userSelect: "none",
          flexShrink: 0,
        },
        (theme) =>
          theme.applyStyles("dark", {
            // The mark is a dark charcoal tile, so on the onyx canvas its
            // silhouette dissolves into the background. A hairline halo traced
            // from the artwork's own alpha edge lifts it back off the surface
            // without recolouring or inverting the brand.
            filter: `drop-shadow(0 0 1px ${highlight(0.22)}) drop-shadow(0 1px 3px ${darkInk(0.55)})`,
          }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...rest}
    />
  );
};
