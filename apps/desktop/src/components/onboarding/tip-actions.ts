import type { OnboardingTipId } from "../../utils/tips";

/**
 * In-page tip actions mutate the state of the tip's own route page — the
 * generative-provider tip's action opens Settings' Groq dialog, which only
 * the Settings page can do. The page registers its handler on mount and
 * unregisters it on unmount; the floating tip stack looks the handler up at
 * click time. A tip is only shown on its own route (see `TipToaster`), so
 * while the tip is on screen, its page is mounted and the handler is
 * registered.
 */
const handlers = new Map<OnboardingTipId, () => void>();

export const setTipAction = (
  id: OnboardingTipId,
  handler: () => void,
): (() => void) => {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) {
      handlers.delete(id);
    }
  };
};

export const getTipAction = (id: OnboardingTipId): (() => void) | undefined =>
  handlers.get(id);
