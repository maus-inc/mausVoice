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
