// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useSettingsNavigation } from "./useSettingsNavigation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Consumer = () => {
  useSettingsNavigation();
  return null;
};

describe("useSettingsNavigation", () => {
  it("coalesces scroll events and cancels a queued frame even when its id is zero", async () => {
    const request = vi.fn(() => 0);
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Consumer />));
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
    expect(cancel).toHaveBeenCalledWith(0);
  });
});
