// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(() => Promise.resolve(null)) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

const platform = vi.hoisted(() => ({ name: "windows" as "windows" | "macos" }));
vi.mock("../../utils/platform.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/platform.utils")>();
  return { ...actual, getPlatform: () => platform.name };
});
vi.mock("../../utils/env.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/env.utils")>();
  return {
    ...actual,
    isWindows: () => platform.name === "windows",
    isMacOS: () => platform.name === "macos",
    isLinux: () => false,
  };
});

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
      messages: {},
    }),
  };
});

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { sectionAnchorId } from "./SettingsSectionNav";
import { SETTING_SECTIONS } from "../../utils/settings-registry";
import SettingsPage from "./SettingsPage";

ensureUiHarness();

/**
 * The settings rail highlights whichever section the reader is inside.
 *
 * `DashboardPage` renders settings inside an `Outlet` Box with
 * `overflow: "auto"`, so the element that scrolls is that Box and NOT the
 * window — `DashboardPage` puts `overflow: "hidden"` on the stack filling the
 * viewport. A `scroll` listener registered on `window` without the capture flag
 * therefore never runs, because a scroll fired on an element does not bubble.
 *
 * These tests assert on the listener's observable effect (does a scroll inside a
 * scrolling element re-measure the active section?) rather than on the
 * registration call, so they fail if the listener is attached to the wrong
 * target or with the wrong flags.
 */

describe("settings section scroll tracking", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  /** Stands in for the dashboard's `Outlet` Box, the element that scrolls. */
  let scroller: HTMLDivElement;
  let frames: Array<FrameRequestCallback>;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    // jsdom does not run rAF, so the sampler is driven explicitly: a queued
    // frame is exactly the pending measurement the page is waiting on.
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = () => undefined;
    });
    // jsdom has no layout, so `scrollIntoView` is absent; the page calls it on
    // every rail click.
    Element.prototype.scrollIntoView = vi.fn();

    setAppState(structuredClone(INITIAL_APP_STATE), true);
    scroller = document.createElement("div");
    document.body.appendChild(scroller);
    container = document.createElement("div");
    scroller.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    scroller.remove();
    document.body.innerHTML = "";
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });

  const renderPage = async () => {
    platform.name = "windows";
    await act(async () => {
      root?.render(createElement(SettingsPage));
    });
    // Drain the measurement the mount effect queues.
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
  };

  /**
   * Give the section anchors the tops a scroll position implies. Every registry
   * section is placed, not just the ones under test: an unplaced anchor keeps
   * jsdom's zero rect, which would read as "at the fold" and win the
   * last-section-wins comparison over the sections actually being tested.
   */
  const placeSections = (tops: Record<string, number>) => {
    let unplaced = 2000;
    for (const entry of SETTING_SECTIONS) {
      const node = document.getElementById(sectionAnchorId(entry.id));
      if (!node) throw new Error(`no anchor rendered for section ${entry.id}`);
      const top = tops[entry.id] ?? (unplaced += 500);
      node.getBoundingClientRect = () =>
        ({ top, bottom: top + 100 }) as DOMRect;
    }
  };

  const selectedRailEntry = () => {
    const selected = Array.from(
      document.querySelectorAll('nav button[aria-current="true"]'),
    ).map((node) => node.textContent);
    return selected[0] ?? null;
  };

  /** Scroll the container and drain the measurement it queues. */
  const scrollAndMeasure = async (place: () => void) => {
    await act(async () => {
      place();
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(frames.length).toBeGreaterThan(0);
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
  };

  it("re-measures when the scrolling container scrolls", async () => {
    await renderPage();

    // Only the first section is at or above the fold, so the rail selects it.
    await scrollAndMeasure(() => placeSections({ general: -10 }));
    expect(selectedRailEntry()).toBe("General");

    // The reader scrolls the dashboard's Box. This is the event a bubble-phase
    // window listener would never see.
    await scrollAndMeasure(() =>
      placeSections({ general: -400, dictation: -10 }),
    );

    expect(selectedRailEntry()).toBe("Dictation");
  });

  it("coalesces a burst of scroll events into one measurement", async () => {
    await renderPage();
    await scrollAndMeasure(() => placeSections({ general: -10 }));

    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
      }
    });

    // Sampled through rAF, so five events cost one layout pass.
    expect(frames).toHaveLength(1);
  });

  it("renders one anchor per registry section, using the rail's own ids", async () => {
    await renderPage();

    for (const entry of SETTING_SECTIONS) {
      const node = document.getElementById(sectionAnchorId(entry.id));
      expect(node, `anchor for ${entry.id}`).not.toBeNull();
    }
    // Exactly one wrapper per section, so a rail button cannot scroll to an
    // empty target or highlight a section that is not rendered.
    const rendered = Array.from(
      document.querySelectorAll<HTMLElement>("[id^='section-']"),
    ).map((node) => node.id);
    expect(rendered).toHaveLength(SETTING_SECTIONS.length);
    expect(new Set(rendered).size).toBe(SETTING_SECTIONS.length);
  });

  it("renders the section anchors in registry order", async () => {
    await renderPage();

    const order = Array.from(
      document.querySelectorAll<HTMLElement>("[id^='section-']"),
    ).map((node) => node.id);
    expect(order).toEqual(
      SETTING_SECTIONS.map((entry) => sectionAnchorId(entry.id)),
    );
  });
});
