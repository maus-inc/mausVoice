import { useSyncExternalStore } from "react";
import type { Transition, Variants } from "framer-motion";

/** Emil Kowalski–style motion tokens for product UI. */
export const easeOutQuint = [0.23, 1, 0.32, 1] as const;
export const easeOutCubic = [0.33, 1, 0.68, 1] as const;
export const easeInOutCubic = [0.645, 0.045, 0.355, 1] as const;

export const cssEase = (points: readonly number[]): string =>
  `cubic-bezier(${points.join(", ")})`;

export const duration = {
  instant: 0.1,
  fast: 0.15,
  base: 0.2,
  enter: 0.25,
  exit: 0.18,
} as const;

export const springSnappy = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.8,
};
export const springSoft = {
  type: "spring" as const,
  stiffness: 280,
  damping: 28,
  mass: 0.9,
};

/** Watermelon layout morph (morphing-button / contextual-ai-bar). */
export const springLayout = {
  type: "spring" as const,
  stiffness: 240,
  damping: 18,
  mass: 1.1,
};

/** Watermelon popLayout icon swap (copy-confirm / voice-transcribe). */
export const springPop = {
  type: "spring" as const,
  duration: 0.3,
  bounce: 0,
};

/** Short press-down feedback for custom pressable surfaces. */
export const pressScale = 0.97;
export const pressTransition: Transition = {
  duration: duration.instant,
  ease: easeOutCubic,
};

/** Shared enter/exit language: fade with a small rise in, lift out. */
export const riseVariants: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.99 },
  shown: { opacity: 1, y: 0, scale: 1 },
  gone: { opacity: 0, y: -6, scale: 0.99 },
};

/** Opacity-only enter/exit for reduced motion. */
export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
  gone: { opacity: 0 },
};

export const enterTransition: Transition = springSnappy;
export const exitTransition: Transition = { duration: duration.exit };

/** Layout continuity for reordering or resizing content. */
export const layoutTransition: Transition = springSoft;

/** Brief emphasis pop for state confirmation. */
export const emphasisTransition: Transition = {
  type: "spring",
  stiffness: 550,
  damping: 16,
  mass: 0.7,
};

export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/**
 * Matches a pointer that cannot hover, which on every current platform means a
 * touch screen. Any control whose only affordance is a :hover state has to
 * carry a resting state under this query, or it is invisible on touch.
 */
export const noHoverQuery = "(hover: none)";

/**
 * Shared subscription for {@link noHoverQuery}.
 *
 * `useMediaQuery` attaches a fresh `matchMedia` listener per call, so calling
 * it once per rendered message means a hundred messages add a hundred
 * subscriptions that all fire on the same change. One module-level listener
 * feeds every caller instead.
 */
const noHoverListeners = new Set<(matches: boolean) => void>();
let noHoverMediaQuery: MediaQueryList | null = null;

/** Whether the environment can answer the query at all. */
const canMatchMedia = (): boolean =>
  typeof globalThis.matchMedia === "function";

const readNoHover = (): boolean => {
  if (!noHoverMediaQuery && canMatchMedia()) {
    noHoverMediaQuery = globalThis.matchMedia(noHoverQuery);
    // Only the modern registration is used. `addListener` is deprecated and
    // kept the deprecated-call lint open; every engine that can answer a hover
    // query can also register for it.
    if (typeof noHoverMediaQuery.addEventListener === "function") {
      noHoverMediaQuery.addEventListener("change", (event) => {
        for (const each of noHoverListeners) each(event.matches);
      });
    }
  }
  return noHoverMediaQuery?.matches ?? false;
};

const subscribeNoHover = (listener: (matches: boolean) => void) => {
  noHoverListeners.add(listener);
  readNoHover();
  return () => {
    noHoverListeners.delete(listener);
  };
};

/**
 * True when the pointer cannot hover, so a hover-only affordance would never
 * appear. One subscription is shared across every caller.
 *
 * Assumes hover, which is the safe default: a caller that only reveals on hover
 * then keeps its resting state rather than hiding a control entirely.
 */
export const useNoHoverPointer = (): boolean =>
  useSyncExternalStore(subscribeNoHover, readNoHover, () => false);
