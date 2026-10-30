// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { useSettingsAnchor } from "./use-settings-anchor";

ensureUiHarness();
const clearQuery = () => {};
const Probe = ({ available, hash }: { available: boolean; hash: string }) => {
  const { highlight } = useSettingsAnchor(
    hash,
    "privacy-data",
    available,
    clearQuery,
  );
  return createElement(
    "div",
    null,
    createElement("output", null, highlight),
    available && createElement("div", { id: "setting-elevenlabs_keyterms" }),
  );
};

describe("settings anchors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reveals a requested row after its availability arrives, and does not repeat after success", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const render = async (
      available: boolean,
      hash = "#setting-elevenlabs_keyterms",
    ) => {
      await act(async () => {
        root.render(createElement(Probe, { available, hash }));
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    };
    try {
      await render(false);
      expect(scroll).not.toHaveBeenCalled();
      await render(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({
        behavior: "instant",
        block: "center",
      });
      expect(container.querySelector("output")?.textContent).toBe(
        "elevenlabs_keyterms",
      );
      await render(false);
      await render(true);
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("forgets a missing target when navigation changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      await act(async () =>
        root.render(
          createElement(Probe, {
            available: false,
            hash: "#setting-elevenlabs_keyterms",
          }),
        ),
      );
      await act(async () =>
        root.render(createElement(Probe, { available: true, hash: "" })),
      );
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
