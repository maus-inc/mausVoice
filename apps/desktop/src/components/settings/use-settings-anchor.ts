import { useCallback, useEffect, useRef, useState } from "react";
import { settingAnchorId } from "./settings-routes";

/** Scroll and highlight only once the requested row has actually mounted. */
export const useSettingsAnchor = (
  hash: string,
  page: string | undefined,
  availability: unknown,
  clearQuery: () => void,
) => {
  const [highlight, setHighlight] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const requestedFocus = useRef<{ key: string; origin: Element | null } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  const focusSetting = useCallback(
    (key: string) => {
      clearQuery();
      pending.current = key;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const row = document.getElementById(settingAnchorId(key));
        if (!row || pending.current !== key) return;
        pending.current = null;
        const request = requestedFocus.current;
        if (request?.key === key) {
          requestedFocus.current = null;
          const active = document.activeElement;
          // Don't take focus back if the person moved it while a row was loading.
          if (
            active === request.origin ||
            active === document.body ||
            active === document.documentElement
          ) {
            const target = row.matches("button:not(:disabled)")
              ? row
              : row.querySelector<HTMLElement>(
                  'input:not([type="hidden"]):not(:disabled), button:not(:disabled), [role="combobox"]:not([aria-disabled="true"]), [tabindex="0"]',
                );
            if (target) {
              target.focus({ preventScroll: true });
            } else {
              row.setAttribute("tabindex", "-1");
              const label = document.getElementById(
                `${settingAnchorId(key)}-label`,
              );
              if (label) row.setAttribute("aria-labelledby", label.id);
              row.focus({ preventScroll: true });
            }
          }
        }
        const reduceMotion = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        row.scrollIntoView({
          behavior: reduceMotion ? "instant" : "smooth",
          block: "center",
        });
        setHighlight(key);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setHighlight(null), 2400);
      });
    },
    [clearQuery],
  );

  const requestFocus = useCallback((key: string) => {
    requestedFocus.current = { key, origin: document.activeElement };
  }, []);

  const cancelPendingFocus = useCallback(() => {
    pending.current = null;
    requestedFocus.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  useEffect(() => {
    pending.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timer.current !== null) window.clearTimeout(timer.current);
    setHighlight(null);
    const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
    if (
      requestedFocus.current &&
      settingAnchorId(requestedFocus.current.key) !== anchor
    ) {
      requestedFocus.current = null;
    }
    if (anchor.startsWith("setting-")) focusSetting(anchor.slice(8));
  }, [hash, page, focusSetting]);

  // Provider-dependent rows mount only after keys have loaded. Retry only a
  // still-pending target, not a row that was already revealed to the user.
  useEffect(() => {
    if (pending.current) focusSetting(pending.current);
  }, [availability, focusSetting]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { highlight, focusSetting, requestFocus, cancelPendingFocus };
};
