// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { scheduleOwnedTimer } from "./dictation-timers";
import { useDictationTimers } from "./dictation-timers.hooks";

it("cancels all five owned timers when the dictation surface unmounts", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const callback = vi.fn();
  const Probe = () => {
    const timers = useDictationTimers();
    return createElement("button", {
      onClick: () => {
        for (const ref of [
          timers.recordingWarningTimerRef,
          timers.recordingAutoStopTimerRef,
          timers.providerWarningTimerRef,
          timers.providerAutoStopTimerRef,
          timers.cancelPromptTimerRef,
        ]) {
          scheduleOwnedTimer(ref, callback, 100);
        }
      },
    });
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => container.querySelector("button")?.click());
    expect(vi.getTimerCount()).toBe(5);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(callback).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
