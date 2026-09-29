import { useColorScheme, useTheme } from "@mui/material";
import { useReducedMotion } from "framer-motion";
import { MetalFx, type MetalFxProps } from "metal-fx";
import { useEffect, useId, useState } from "react";
import "./MetalChrome.css";

/** Data attribute that lets MetalChrome find the wrapper metal-fx renders. */
export const METAL_CHROME_ATTR = "data-mv-metal-chrome";
/** Class applied only when the safety net has fired (see MetalChrome.css). */
export const METAL_CHROME_RESCUED_CLASS = "mv-metal-chrome--rescued";
/**
 * How long metal-fx gets to paint its first frame before the wrapped control
 * is rescued. Generous on purpose: a slow shader compile should still get the
 * library's own fade-in, and the rescue is lifted again if it paints later.
 */
export const METAL_CHROME_RESCUE_DELAY_MS = 1500;

const findWrapper = (id: string): HTMLElement | null => {
  for (const el of document.querySelectorAll<HTMLElement>(
    `[${METAL_CHROME_ATTR}]`,
  )) {
    if (el.getAttribute(METAL_CHROME_ATTR) === id) return el;
  }
  return null;
};

/**
 * metal-fx keeps its wrapper at inline `visibility: hidden` until the WebGL
 * renderer copies a first frame. If that never happens (context lost, GPU
 * reset, shader init failure in the webview), the wrapped control stays
 * invisible and unclickable. Rescue it only in that failure state.
 *
 * The check is purely state-based and deliberately independent of `paused`
 * (reduced motion): it reacts to the library's own hidden state in every mode.
 * Whenever metal-fx reveals the wrapper itself, the rescue never applies (or is
 * lifted); if it never does, even while paused, the control is rescued, since
 * an unusable control is worse than an unpainted ring.
 */
const useFirstFrameRescue = (id: string): boolean => {
  const [rescued, setRescued] = useState(false);

  useEffect(() => {
    const el = findWrapper(id);
    if (!el) return;
    const isHidden = () => el.style.visibility === "hidden";

    // If the library reveals the wrapper later (slow first frame), hand
    // control straight back to it.
    const observer = new MutationObserver(() => {
      if (!isHidden()) setRescued(false);
    });
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });

    const timer = window.setTimeout(() => {
      if (isHidden()) setRescued(true);
    }, METAL_CHROME_RESCUE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [id]);

  return rescued;
};

/**
 * Quiet silver ring — watermelon hairline energy, not a full liquid-metal demo.
 * Glow off, low strength; reduced motion freezes the shader.
 */
export const MetalChrome = ({
  children,
  variant = "button",
  className,
  ...rest
}: MetalFxProps) => {
  const { mode, systemMode } = useColorScheme();
  const theme = useTheme();
  const resolved =
    (mode === "system" ? systemMode : mode) ?? theme.palette.mode;
  const reduceMotion = useReducedMotion();
  const id = useId();
  const rescued = useFirstFrameRescue(id);

  const classes = [rescued ? METAL_CHROME_RESCUED_CLASS : null, className]
    .filter(Boolean)
    .join(" ");

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
      {...{ [METAL_CHROME_ATTR]: id }}
      className={classes || undefined}
    >
      {children}
    </MetalFx>
  );
};
