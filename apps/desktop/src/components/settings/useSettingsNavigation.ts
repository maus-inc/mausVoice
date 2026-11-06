import { useCallback, useEffect, useRef, useState } from "react";
import {
  SETTING_SECTIONS,
  type SettingSectionId,
} from "../../utils/settings-registry";
import { sectionAnchorId, sectionFromScrollTop } from "./SettingsSectionNav";

/** Search highlighting and scroll-aware navigation for the settings page. */
export const useSettingsNavigation = () => {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const focusSetting = useCallback((key: string) => {
    setQuery("");
    setHighlight(key);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 2400);
    requestAnimationFrame(() => {
      document
        .getElementById(`setting-${key}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const [activeSection, setActiveSection] = useState<SettingSectionId | null>(
    null,
  );

  const jumpToSection = useCallback((section: SettingSectionId) => {
    document
      .getElementById(sectionAnchorId(section))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Set immediately rather than waiting for the scroll to land: the smooth
    // scroll fires scroll events along the way, and leaving the rail unselected
    // until then reads as a dropped click.
    setActiveSection(section);
  }, []);

  // Track which section the reader is in.
  //
  // The scrolling element is the dashboard's `Outlet` Box (`overflow: "auto"`),
  // NOT the window: `DashboardPage` sets `overflow: "hidden"` on the stack that
  // fills the viewport, so the window itself never scrolls. A `scroll` event
  // fired on an element does not bubble, so a listener on `window` in the
  // bubble phase would never run for settings scrolling at all — which is why
  // this registers on `window` with the capture flag instead, the same reason
  // `ContextMenu.tsx` passes `true`. Capture sees the event on its way down to
  // the scrolling Box regardless of which element scrolls.
  //
  // Positions are measured against the viewport (`getBoundingClientRect().top`
  // with an offset of 0), so the measurement stays correct whichever element
  // is doing the scrolling. Sampling through rAF keeps a fast scroll from
  // running layout per event.
  useEffect(() => {
    if (query.trim()) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const tops = SETTING_SECTIONS.map(
        (entry) =>
          [
            entry.id,
            document
              .getElementById(sectionAnchorId(entry.id))
              ?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
          ] as const,
      );
      setActiveSection(sectionFromScrollTop(tops, 0));
    };
    const onScroll = () => {
      frame ??= requestAnimationFrame(measure);
    };
    measure();
    // `capture: true` is load-bearing here, not a default: it is what makes a
    // scroll inside the dashboard's Box reach this listener at all.
    window.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [query]);

  return {
    query,
    setQuery,
    highlight,
    focusSetting,
    activeSection,
    jumpToSection,
  };
};
