// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  stage: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  state: { activeRecordingMode: null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../../utils/overlay.utils", () => ({
  sendPillStageText: mocks.stage,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: mocks.warning, error: mocks.error }),
}));
import { usePillPhaseSync } from "./dictation-phase.hooks";

it("does not retry an older failed phase over a newer successful phase", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  let reject!: (reason: Error) => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  const root = createRoot(document.createElement("div"));
  let send!: ReturnType<typeof usePillPhaseSync>;
  const Probe = () => {
    send = usePillPhaseSync(true);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    const old = send("idle");
    await send("recording");
    reject(new Error("old failed"));
    await old;
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("set_phase", {
      phase: "recording",
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("reconciles a failed idle write on the heartbeat and stops on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.invoke
    .mockReset()
    .mockRejectedValueOnce(new Error("pipe"))
    .mockRejectedValueOnce(new Error("pipe"))
    .mockResolvedValue(undefined);
  mocks.state.activeRecordingMode = null;
  const root = createRoot(document.createElement("div"));
  let send!: ReturnType<typeof usePillPhaseSync>;
  const Probe = () => {
    send = usePillPhaseSync(true);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => send("idle"));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
