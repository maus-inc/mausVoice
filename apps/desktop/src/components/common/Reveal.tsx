import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { duration, easeOutQuint } from "../../styles/motion";

export type RevealProps = {
  /**
   * Whether the content is shown. This primitive owns that condition so it can
   * animate the removal as well as the arrival -- a `visible && <X/>` at the
   * call site drops the exit, because the element is already gone before
   * anything can animate it out.
   */
  show: boolean;
  children: ReactNode;
};

/**
 * Expands and collapses a block of content in place, for a section whose
 * appearance is a *consequence* rather than a navigation.
 *
 * Deliberately not `AnimateIn`: that animates a rise and a fade, which reads as
 * "a new thing arrived" and is right for panels and routes. Here the copy that
 * appears explains a control the user is looking at -- a switch they just
 * flipped -- so translating it makes the dialog look like it jumped. The height
 * grows from nothing and the opacity comes up underneath it; nothing moves.
 *
 * Three implementation notes, each of which was a bug in the first cut:
 *
 * - The height is animated on a grid track (`0fr` to `1fr`), not `height: auto`.
 *   `auto` is not interpolable, so the block would snap open. The track needs a
 *   `min-height: 0` child or the row refuses to close below its content size.
 * - The clip is dropped once the expansion has settled. Left on permanently it
 *   clips the focus ring of a keyboard user who tabs into the block, and clips a
 *   slider's value label, which is drawn above its thumb and outside the content
 *   box. Clipping is only needed while the height is changing.
 * - It is restored on the first frame of the exit, from the same effect that
 *   flips the flag, so the content is never clipped while it sits still and
 *   never visible outside its container while it moves.
 *
 * Reduced motion sets the duration to zero rather than removing the animation,
 * so mount and unmount behave identically in both modes and there is no second
 * code path to keep in step.
 */
export const Reveal = ({ show, children }: RevealProps) => {
  const reduceMotion = useReducedMotion();
  const seconds = reduceMotion ? 0 : duration.enter;
  // Starts unclipped so a block that is shown on first render (a preference
  // restored by the time the dialog opens) is never briefly clipped.
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (!show) {
      setClipped(true);
    }
  }, [show]);

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          style={{ display: "grid", overflow: clipped ? "hidden" : "visible" }}
          initial={{ gridTemplateRows: "0fr", opacity: 0 }}
          animate={{ gridTemplateRows: "1fr", opacity: 1 }}
          exit={{ gridTemplateRows: "0fr", opacity: 0 }}
          transition={{
            gridTemplateRows: { duration: seconds, ease: easeOutQuint },
            opacity: { duration: seconds },
          }}
          onAnimationComplete={() => setClipped(false)}
          onAnimationStart={() => setClipped(true)}
        >
          <div style={{ minHeight: 0, overflow: "hidden" }}>{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
