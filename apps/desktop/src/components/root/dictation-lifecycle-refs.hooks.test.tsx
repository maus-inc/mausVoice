// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useDictationLifecycleRefs } from "./dictation-lifecycle-refs.hooks";

it("retains recording ownership refs across renders and isolates separate owners", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const firstRoot = createRoot(document.createElement("div"));
  const secondRoot = createRoot(document.createElement("div"));
  const snapshots: ReturnType<typeof useDictationLifecycleRefs>[] = [];
  const Probe = () => {
    snapshots.push(useDictationLifecycleRefs());
    return null;
  };
  try {
    await act(async () => firstRoot.render(createElement(Probe)));
    snapshots[0].recordingOperationRef.current = 12;
    snapshots[0].recordingSessionRef.current = () => true;
    snapshots[0].isPausedRef.current = true;
    snapshots[0].utteranceTonesRef.current.seed("tone");
    await act(async () => firstRoot.render(createElement(Probe)));
    expect(snapshots[1].recordingOperationRef).toBe(
      snapshots[0].recordingOperationRef,
    );
    expect(snapshots[1].recordingSessionRef).toBe(
      snapshots[0].recordingSessionRef,
    );
    expect(snapshots[1].isPausedRef.current).toBe(true);
    expect(snapshots[1].utteranceTonesRef.current.read().start).toBe("tone");
    await act(async () => secondRoot.render(createElement(Probe)));
    expect(snapshots[2].recordingOperationRef.current).toBe(0);
    expect(snapshots[2].recordingSessionRef.current).toBeNull();
    expect(snapshots[2].isPausedRef.current).toBe(false);
  } finally {
    await act(async () => {
      firstRoot.unmount();
      secondRoot.unmount();
    });
    vi.unstubAllGlobals();
  }
});
