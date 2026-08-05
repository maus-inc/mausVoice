/** Emil Kowalski–style motion tokens for product UI. */
export const easeOutQuint = [0.23, 1, 0.32, 1] as const;
export const easeOutCubic = [0.33, 1, 0.68, 1] as const;
export const easeInOutCubic = [0.645, 0.045, 0.355, 1] as const;

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

export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
