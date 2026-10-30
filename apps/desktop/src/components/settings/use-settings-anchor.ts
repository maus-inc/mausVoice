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

  useEffect(() => {
    pending.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timer.current !== null) window.clearTimeout(timer.current);
    setHighlight(null);
    const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
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

  return { highlight, focusSetting };
};
