// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  end: vi.fn(),
  release: vi.fn<(refs: unknown) => void>(),
  state: {
    userPrefs: { dictationAudioDim: 0.5 },
    activeRecordingMode: "dictate" as string | null,
    dictationLanguageOverride: "fr" as string | null,
    assistantInputMode: "type",
  },
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn() }),
}));
vi.mock("./dictation-volume-dim", () => ({
  createSystemVolumeDim: () => ({ endRecording: mocks.end, dim: vi.fn() }),
}));
vi.mock("./dictation-recording-intake", () => ({
  releaseRecordingResources: mocks.release,
  takeRecordingResources: (refs: Record<string, { current: unknown }>) => {
    const owned: Record<string, { current: unknown }> = {};
    for (const [key, ref] of Object.entries(refs)) {
      owned[key] = { current: ref.current };
      ref.current = null;
    }
    return owned;
  },
}));
vi.mock("../../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
import { useDictationLifecycle } from "./dictation-lifecycle.hooks";

it("still releases the recorder if volume restoration throws on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.end.mockReset();
  mocks.release.mockClear();
  mocks.end.mockImplementationOnce(() => {
    throw new Error("volume unavailable");
  });
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationLifecycle();
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.unmount());
    expect(mocks.release).toHaveBeenCalledOnce();
  } finally {
    mocks.end.mockReset();
    vi.unstubAllGlobals();
  }
});

it("keeps the old lease when volume restoration reenters with a successor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.end.mockReset();
  mocks.release.mockClear();
  const root = createRoot(document.createElement("div"));
  let owner!: ReturnType<typeof useDictationLifecycle>;
  const Probe = () => {
    owner = useDictationLifecycle();
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    const oldLease = {} as NonNullable<
      typeof owner.nativeStartOwnerRef.current
    >;
    const newLease = {} as NonNullable<
      typeof owner.nativeStartOwnerRef.current
    >;
    owner.nativeStartOwnerRef.current = oldLease;
    mocks.end.mockImplementationOnce(() => {
      owner.recordingOperationRef.current++;
      owner.nativeStartOwnerRef.current = newLease;
    });
    await act(async () => root.unmount());
    const released = mocks.release.mock.calls[0][0] as {
      nativeStartOwnerRef: { current: typeof oldLease | null };
      isCurrent: () => boolean;
    };
    expect(released.nativeStartOwnerRef.current).toBe(oldLease);
    expect(released.isCurrent()).toBe(false);
    expect(owner.nativeStartOwnerRef.current).toBe(newLease);
  } finally {
    mocks.end.mockReset();
    vi.unstubAllGlobals();
  }
});

it("invalidates pending work before volume and resource cleanup on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.end.mockClear();
  mocks.release.mockClear();
  const root = createRoot(document.createElement("div"));
  let owner!: ReturnType<typeof useDictationLifecycle>;
  const Probe = () => {
    owner = useDictationLifecycle();
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    owner.recordingOperationRef.current = 4;
    owner.isPausedRef.current = true;
    owner.clearRecordingState();
    expect(owner.isPausedRef.current).toBe(false);
    expect(mocks.state.activeRecordingMode).toBeNull();
    await act(async () => root.unmount());
    expect(owner.recordingOperationRef.current).toBe(5);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: owner.sessionRef,
        strategyRef: owner.strategyRef,
      }),
    );
    expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0],
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
