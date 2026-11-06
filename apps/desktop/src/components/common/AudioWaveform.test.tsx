// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioWaveform } from "./AudioWaveform";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

describe("AudioWaveform", () => {
  it("updates an inactive baseline when only its offset changes", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <AudioWaveform levels={[]} active={false} width={100} height={20} />,
        ),
      );
      expect(container.querySelector("path")?.getAttribute("d")).toBe(
        "M 0 10 L 100 10",
      );
      await act(async () =>
        root.render(
          <AudioWaveform
            levels={[]}
            active={false}
            width={100}
            height={20}
            baselineOffset={4}
          />,
        ),
      );
      expect(container.querySelector("path")?.getAttribute("d")).toBe(
        "M 0 14 L 100 14",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("restarts animation at a new offset and cancels a frame with id zero", async () => {
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length - 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <AudioWaveform levels={[]} active width={100} height={20} />,
        ),
      );
      expect(request).toHaveBeenCalledTimes(1);
      await act(async () =>
        root.render(
          <AudioWaveform
            levels={[]}
            active
            width={100}
            height={20}
            baselineOffset={4}
          />,
        ),
      );
      expect(cancel).toHaveBeenCalledWith(0);
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => callbacks[1](0));
      const path = container.querySelector("path")?.getAttribute("d") ?? "";
      const firstY = Number(path.match(/^M 0 ([^ ]+)/)?.[1]);
      expect(firstY).toBeGreaterThan(14);
      expect(firstY).toBeLessThan(15);
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("draws processing waves without microphone levels and resets when idle", async () => {
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length - 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <AudioWaveform
            levels={[]}
            active={false}
            processing
            width={100}
            height={20}
          />,
        ),
      );
      await act(async () => callbacks[0](0));
      const paths = [...container.querySelectorAll("path")];
      expect(paths).toHaveLength(3);
      expect(paths[0].getAttribute("d")).toMatch(/^M 0 /);
      expect(paths[0].getAttribute("d")).not.toBe("M 0 10 L 100 10");
      expect(paths.map((path) => path.getAttribute("opacity"))).toEqual([
        "1",
        "0.78",
        "0.56",
      ]);
      await act(async () =>
        root.render(
          <AudioWaveform levels={[]} active={false} width={100} height={20} />,
        ),
      );
      expect(
        paths.every((path) => path.getAttribute("d") === "M 0 10 L 100 10"),
      ).toBe(true);
      expect(cancel).toHaveBeenCalledWith(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
