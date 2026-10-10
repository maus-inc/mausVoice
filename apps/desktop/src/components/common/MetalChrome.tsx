import { useReducedMotion } from "framer-motion";
import { MetalFx, type MetalFxProps } from "metal-fx";
import { useEffect, useId, useState } from "react";
import { useIsDarkMode } from "../../hooks/color-scheme.hooks";
import { getLogger } from "../../utils/log.utils";
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
/**
 * How long the pending lookup waits for metal-fx to render its wrapper before
 * giving up on it. Without a deadline the observer stayed attached for the
 * component's whole lifetime, and this app re-renders continuously while
 * dictation runs and while toasts mount and unmount, so every mutation batch
 * paid a full-document `findWrapper` scan for a wrapper that was never coming.
 */
export const METAL_CHROME_PENDING_LOOKUP_MS = 4000;

const findWrapper = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[${METAL_CHROME_ATTR}="${id}"]`);

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
    let stopped = false;
    let detach: (() => void) | undefined;

    // Takes ownership of a wrapper that exists now: watches its inline
    // visibility and keeps one rescue timer armed for as long as the wrapper
    // is hidden.
    const attach = (el: HTMLElement) => {
      const isHidden = () => el.style.visibility === "hidden";

      let timer = 0;
      const arm = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (isHidden()) setRescued(true);
        }, METAL_CHROME_RESCUE_DELAY_MS);
      };

      let hidden = isHidden();
      const observer = new MutationObserver(() => {
        const nowHidden = isHidden();
        // metal-fx revealed the wrapper (first frame, possibly late), so hand
        // control straight back to it.
        if (!nowHidden) {
          hidden = false;
          setRescued(false);
          return;
        }
        // Hidden again after a reveal is a lost WebGL context or a GPU reset.
        // The timer that armed the first rescue is long spent, so a new one is
        // needed or the control stays invisible and unclickable.
        if (!hidden) {
          hidden = true;
          arm();
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ["style"] });
      arm();

      detach = () => {
        window.clearTimeout(timer);
        observer.disconnect();
      };
    };

    const el = findWrapper(id);
    if (el) {
      attach(el);
    } else {
      // metal-fx can render its wrapper after this effect runs. A missing
      // wrapper is a first state, not a failure, so wait for the insertion
      // instead of giving up on a lookup that only got asked once. The wait is
      // bounded: past the deadline the wrapper is treated as never arriving and
      // the observer is detached, so a library that fails to mount, sits behind
      // a Suspense that never resolves, or whose id never matches cannot leave a
      // whole-document observer running for the rest of the component's life.
      let deadline = 0;
      const pending = new MutationObserver(() => {
        if (stopped) return;
        const found = findWrapper(id);
        if (!found) return;
        window.clearTimeout(deadline);
        pending.disconnect();
        attach(found);
      });
      pending.observe(document.body, { childList: true, subtree: true });
      deadline = window.setTimeout(() => {
        pending.disconnect();
        getLogger().warning(
          `[MetalChrome] metal-fx wrapper ${id} never appeared within ${METAL_CHROME_PENDING_LOOKUP_MS}ms; stopped watching for it`,
        );
      }, METAL_CHROME_PENDING_LOOKUP_MS);
      detach = () => {
        window.clearTimeout(deadline);
        pending.disconnect();
      };
    }

    return () => {
      stopped = true;
      detach?.();
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
  const dark = useIsDarkMode();
  const reduceMotion = useReducedMotion();
  const id = useId();
  const rescued = useFirstFrameRescue(id);

  const classes = [rescued ? METAL_CHROME_RESCUED_CLASS : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <MetalFx
      preset="silver"
      theme={dark ? "dark" : "light"}
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
