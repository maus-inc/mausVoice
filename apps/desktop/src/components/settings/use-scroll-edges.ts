import { useCallback, useEffect, useState } from "react";

/**
 * Whether a scroll container is scrolled away from each end.
 *
 * The dialog is taller than a short window: at 520 px the content is clipped
 * mid-sentence and the only hint that more exists is a text line cut in half.
 * A fade at the edge makes the cut look deliberate -- but only while something
 * is actually hidden. A permanent gradient would dim the last line even when
 * the whole dialog fits, so this reports the two edges separately and the
 * caller draws nothing when neither is set.
 *
 * Both edges are reported because they mean different things: content hidden
 * below the fold invites a scroll, content hidden above it says the user has
 * already scrolled and can come back.
 */
export type ScrollEdges = {
  top: boolean;
  bottom: boolean;
};

const NONE: ScrollEdges = { top: false, bottom: false };

/**
 * Tracks the scroll position of `node`.
 *
 * Takes the element rather than handing one back, because the caller already
 * owns a ref to it: `MicrophoneDialog` keeps `contentRef` for the scroll-into-
 * view on save failure, and a second ref on the same element is how two sources
 * of truth start disagreeing.
 *
 * `ResizeObserver` as well as `scroll`, because the container changes size
 * without anyone scrolling: the window resizes, or the reveal animation below
 * expands a section and pushes the content past the fold.
 */
export const useScrollEdges = (
  node: HTMLElement | null,
  active: boolean,
): ScrollEdges => {
  const [edges, setEdges] = useState<ScrollEdges>(NONE);

  const measure = useCallback(() => {
    if (!node) return;
    // One pixel of slack: fractional layout heights mean a container that is
    // exactly scrolled to the bottom can report a sub-pixel remainder, which
    // would leave the fade switched on over nothing.
    const maxScroll = node.scrollHeight - node.clientHeight;
    const next: ScrollEdges = {
      top: node.scrollTop > 1,
      bottom: maxScroll > 1 && node.scrollTop < maxScroll - 1,
    };
    setEdges((previous) =>
      previous.top === next.top && previous.bottom === next.bottom
        ? previous
        : next,
    );
  }, [node]);

  useEffect(() => {
    if (!active || !node) {
      setEdges(NONE);
      return;
    }
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(node);
    // The content is observed too, so a section that grows taller than the
    // container is noticed even though the container's own box did not change.
    if (observer && node.firstElementChild) {
      observer.observe(node.firstElementChild);
    }
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [active, measure, node]);

  return edges;
};
