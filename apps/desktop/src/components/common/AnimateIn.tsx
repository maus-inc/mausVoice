import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { duration, springSnappy } from "../../styles/motion";

export type AnimateInProps = {
  children: React.ReactElement<unknown, any>;
  visible?: boolean;
};

/**
 * Appear/disappear wrapper driven by the shared spring tokens so it matches
 * the sidebar and the rest of the product chrome. Honours reduced motion by
 * falling back to a bare opacity fade.
 */
export const AnimateIn = ({ children, visible = true }: AnimateInProps) => {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          initial={
            reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.99 }
          }
          transition={reduceMotion ? { duration: duration.exit } : springSnappy}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};

export type AnimateSwitchProps = {
  /**
   * Identity of the currently rendered content. When the key changes, the old
   * content springs out and the new content springs in — the same motion
   * language as the sidebar's shared-layout transitions
   * (`springSnappy` in `styles/motion.ts`).
   */
  activeKey: string;
  children: ReactNode;
};

/**
 * Crossfades between mutually exclusive sections (e.g. the off / api / local
 * blocks in the AI configuration menus). `mode="wait"` keeps the container
 * height honest during the swap instead of overlapping absolutely-positioned
 * copies mid-flight.
 */
export const AnimateSwitch = ({ activeKey, children }: AnimateSwitchProps) => {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    // No animation preference stack: render content directly, keyed so state
    // owned by one mode can't bleed into another.
    return <div key={activeKey}>{children}</div>;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeKey}
        style={{ width: "100%" }}
        initial={{ opacity: 0, y: 8, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.99 }}
        transition={springSnappy}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
};
