// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  state: { userPrefs: { dictationPillVisibility: "hidden" }, keysHeld: [] },
  reset: vi.fn(),
  logger: { error: vi.fn(), verbose: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../../utils/user.utils", () => ({
  getEffectivePillVisibility: (v: string) => v,
}));
vi.mock("../../utils/hotkey-filter.utils", () => ({
  resetHotkeyFilter: mocks.reset,
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import {
  useRecordingControllers,
  useRecordingControllerBindings,
} from "./dictation-controllers.hooks";
import { resolveStartAtNativeDispatch } from "./dictation-recording-intake";
import { NativeRecordingLease } from "../../utils/native-recording-lease";

it.each([false, true])(
  "starts an owned stop on release even if start fails before its reply (release before dispatch: %s)",
  async (releaseBeforeDispatch) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    let finishAdmission!: (token: number) => void;
    let rejectStart!: (error: Error) => void;
    let finishStop!: (value: { samples: number[]; sampleRate: number }) => void;
    const nativeInvoke = vi.fn((command: string) => {
      if (command === "recording_generation")
        return new Promise<number>((resolve) => {
          finishAdmission = resolve;
        });
      if (command === "start_recording")
        return new Promise<{ sampleRate: number }>((_, reject) => {
          rejectStart = reject;
        });
      if (command === "stop_recording")
        return new Promise<{ samples: number[]; sampleRate: number }>(
          (resolve) => {
            finishStop = resolve;
          },
        );
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(nativeInvoke, "release-race");
    const start = (onDispatched?: (operation: number) => void) =>
      resolveStartAtNativeDispatch(async (resolve) => {
        await lease.start(null, false, () => {
          onDispatched?.(17);
          resolve(17);
        });
        return 17;
      });
    let stopped: number[] | undefined;
    const stop = vi.fn(async (operation?: number) => {
      expect(operation).toBe(17);
      stopped = Array.from((await lease.stop()).samples);
    });
    let controls!: ReturnType<typeof useRecordingControllers>;
    const Probe = () => {
      controls = useRecordingControllers([]);
      useRecordingControllerBindings(controls.handlersRef, {
        startDictationRecording: start,
        stopDictationRecording: stop,
        startAgentRecording: start,
        stopAgentRecording: stop,
        startRecording: ({ onNativeStartDispatched }) =>
          start(onNativeStartDispatched),
        stopRecording: stop,
      });
      return null;
    };
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        controls.dictationController.handlePress();
        await vi.waitFor(() => expect(finishAdmission).toBeTypeOf("function"));
      });
      if (releaseBeforeDispatch) controls.dictationController.handleRelease();
      finishAdmission(9);
      await vi.waitFor(() => expect(rejectStart).toBeTypeOf("function"));
      if (!releaseBeforeDispatch) controls.dictationController.handleRelease();
      rejectStart(new Error("start reply lost"));
      await vi.waitFor(() =>
        expect(nativeInvoke).toHaveBeenCalledWith("stop_recording", {
          ownerId: "release-race",
          generation: 9,
        }),
      );
      expect(
        nativeInvoke.mock.calls.some(
          ([command]) => command === "discard_recording",
        ),
      ).toBe(false);
      finishStop({ samples: [0.5], sampleRate: 16000 });
      await vi.waitFor(() => expect(stopped).toEqual([0.5]));
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("cancels a released pre-dispatch startup without waiting for its stalled work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const cancel = vi.fn();
  const start = vi.fn((_notify?: (id: number) => void, signal?: AbortSignal) =>
    resolveStartAtNativeDispatch(() => new Promise(() => {}), signal, cancel),
  );
  const stop = vi.fn().mockResolvedValue(undefined);
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = () => {
    controls = useRecordingControllers([]);
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: start,
      stopDictationRecording: stop,
      startAgentRecording: start,
      stopAgentRecording: stop,
      startRecording: ({ deactivation }) => start(undefined, deactivation),
      stopRecording: stop,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    controls.dictationController.handlePress();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    controls.dictationController.handleRelease();
    expect(cancel).toHaveBeenCalledOnce();
    controls.dictationController.handlePress();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(stop).not.toHaveBeenCalled();
    controls.dictationController.handleRelease();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps controller identity while routing release to the latest committed callback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.invoke.mockClear();
  const root = createRoot(document.createElement("div"));
  const start = vi.fn().mockResolvedValue(123);
  const oldStop = vi.fn().mockResolvedValue(undefined);
  const newStop = vi.fn().mockResolvedValue(undefined);
  let controller!: ReturnType<
    typeof useRecordingControllers
  >["dictationController"];
  const Probe = ({ stop }: { stop: () => Promise<void> }) => {
    const controls = useRecordingControllers([]);
    controller = controls.dictationController;
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: start,
      stopDictationRecording: stop,
      startAgentRecording: start,
      stopAgentRecording: stop,
      startRecording: start,
      stopRecording: stop,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe, { stop: oldStop })));
    const initial = controller;
    await act(async () => {
      controller.handlePress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("set_pill_visibility", {
      visibility: "while_active",
    });
    await act(async () => root.render(createElement(Probe, { stop: newStop })));
    expect(controller).toBe(initial);
    await act(async () => {
      controller.handleRelease();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(newStop).toHaveBeenCalledExactlyOnceWith(123);
    expect(oldStop).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  } finally {
    vi.unstubAllGlobals();
  }
});

it("releases only the activation that a controller actually started", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const startDictation = vi.fn().mockResolvedValue(10);
  const startAgent = vi.fn().mockResolvedValue(20);
  const stopDictation = vi.fn().mockResolvedValue(undefined);
  const stopAgent = vi.fn().mockResolvedValue(undefined);
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = () => {
    controls = useRecordingControllers([]);
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: startDictation,
      stopDictationRecording: stopDictation,
      startAgentRecording: startAgent,
      stopAgentRecording: stopAgent,
      startRecording: startDictation,
      stopRecording: stopDictation,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      controls.dictationController.handlePress();
      await vi.waitFor(() => expect(startDictation).toHaveBeenCalledOnce());
    });
    await act(async () => {
      controls.agentController.toggle();
      await vi.waitFor(() => expect(startAgent).toHaveBeenCalledOnce());
    });
    await act(async () => {
      controls.dictationController.handleRelease();
      await vi.waitFor(() =>
        expect(stopDictation).toHaveBeenCalledExactlyOnceWith(10),
      );
    });
    expect(stopAgent).not.toHaveBeenCalled();
    await act(async () => {
      controls.agentController.toggle();
      await vi.waitFor(() =>
        expect(stopAgent).toHaveBeenCalledExactlyOnceWith(20),
      );
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("starts and stops without waiting for a stalled pill reveal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let reveal!: () => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        reveal = resolve;
      }),
  );
  const start = vi.fn().mockResolvedValue(1);
  const stop = vi.fn().mockResolvedValue(undefined);
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = () => {
    controls = useRecordingControllers([]);
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: start,
      stopDictationRecording: stop,
      startAgentRecording: start,
      stopAgentRecording: stop,
      startRecording: start,
      stopRecording: stop,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      controls.dictationController.handlePress();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
    await act(async () => {
      controls.dictationController.handleRelease();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(1));
    });
    reveal();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("does not stop another recording when activation is rejected by a gate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const blocked = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue(20);
  const stop = vi.fn().mockResolvedValue(undefined);
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = () => {
    controls = useRecordingControllers([]);
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: blocked,
      stopDictationRecording: stop,
      startAgentRecording: start,
      stopAgentRecording: stop,
      startRecording: start,
      stopRecording: stop,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      controls.dictationController.handlePress();
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
    });
    await act(async () => {
      controls.agentController.toggle();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
    await act(async () => {
      controls.dictationController.handleRelease();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stop).not.toHaveBeenCalled();
    await act(async () => {
      controls.agentController.toggle();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(20));
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps an existing language controller when unrelated bindings change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const fr = {
    actionName: "language:fr",
    language: "fr",
    hotkeyCombos: [["f"]],
  };
  const es = {
    actionName: "language:es",
    language: "es",
    hotkeyCombos: [["e"]],
  };
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = ({ entries }: { entries: (typeof fr)[] }) => {
    controls = useRecordingControllers(entries);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe, { entries: [fr] })));
    const first = controls.additionalLanguageControllers[0].controller;
    await act(async () =>
      root.render(
        createElement(Probe, {
          entries: [{ ...fr, hotkeyCombos: [["shift", "f"]] }, es],
        }),
      ),
    );
    expect(controls.additionalLanguageControllers[0].controller).toBe(first);
    expect(controls.additionalLanguageControllers[1].controller).not.toBe(
      first,
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("does not let a reset activation stop its replacement after a late start", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  let finishOld!: (operation: number) => void;
  const start = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(20);
  const stop = vi.fn().mockResolvedValue(undefined);
  let controls!: ReturnType<typeof useRecordingControllers>;
  const Probe = () => {
    controls = useRecordingControllers([]);
    useRecordingControllerBindings(controls.handlersRef, {
      startDictationRecording: start,
      stopDictationRecording: stop,
      startAgentRecording: start,
      stopAgentRecording: stop,
      startRecording: start,
      stopRecording: stop,
    });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      controls.dictationController.handlePress();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
    controls.dictationController.handleRelease();
    controls.dictationController.forceReset();
    controls.dictationController.handlePress();
    await act(async () => {
      finishOld(10);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    });
    expect(stop).not.toHaveBeenCalled();
    await act(async () => {
      controls.dictationController.handleRelease();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(20));
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
