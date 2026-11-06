import { beforeEach, expect, it, vi } from "vitest";
import type { ActivationController } from "../../utils/activation.utils";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: never) => unknown>(),
  toast: null as
    | null
    | ((payload: { action: string; proposalId?: string }) => Promise<void>),
  toggle: vi.fn(),
  switchTone: vi.fn().mockResolvedValue(undefined),
  resolve: vi.fn(),
  alwaysAllow: vi.fn(),
  state: {
    toolPermissionById: {
      permission: {
        toolId: "tool",
        params: { x: 1 },
        conversationId: "conversation",
      },
    },
  },
  error: vi.fn(),
}));
vi.mock("../../hooks/tauri.hooks", () => ({
  useTauriListen: (name: string, callback: (payload?: never) => unknown) =>
    mocks.handlers.set(name, callback),
}));
vi.mock("../../hooks/toast.hooks", () => ({
  useToastAction: (callback: typeof mocks.toast) => {
    mocks.toast = callback;
  },
}));
vi.mock("../../utils/activation.utils", () => ({
  debouncedToggle: mocks.toggle,
}));
vi.mock("../../actions/tone.actions", () => ({
  applyInDictationStyleSwitch: mocks.switchTone,
}));
vi.mock("../../actions/tool.actions", () => ({
  resolveToolPermission: mocks.resolve,
  setToolAlwaysAllow: mocks.alwaysAllow,
}));
vi.mock("../../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: mocks.error }),
}));
import { useDictationPillEvents } from "./dictation-pill-events.hooks";

const setup = (isMainWindow: boolean, paused = false) => {
  const abort = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  const dictationController = {} as ActivationController;
  const agentController = {} as ActivationController;
  const isStoppingRef = { current: true };
  const nativeStartOwnerRef = {
    current: { ownerId: "old-owner" },
  } as unknown as import("./dictation-recording-intake").NativeRecordingLeaseRef;
  useDictationPillEvents({
    isMainWindow,
    isDictationInteractable: true,
    isPausedRef: { current: paused },
    isStoppingRef,
    nativeStartOwnerRef,
    abortRecording: abort,
    pauseDictation: pause,
    resumeDictation: resume,
    dictationController,
    agentController,
  });
  return {
    abort,
    pause,
    resume,
    dictationController,
    agentController,
    isStoppingRef,
    nativeStartOwnerRef,
  };
};
beforeEach(() => {
  mocks.handlers.clear();
  mocks.toast = null;
  vi.clearAllMocks();
});

it("routes pause, resume, toggle and cancellation only to the main window", async () => {
  const controls = setup(true, true);
  mocks.handlers.get("pause-dictation")?.();
  mocks.handlers.get("on-click-dictate")?.();
  mocks.handlers.get("on-click-agent-talk")?.();
  await mocks.toast?.({ action: "confirm_cancel_transcription" });
  expect(controls.pause).toHaveBeenCalledOnce();
  expect(controls.resume).toHaveBeenCalledOnce();
  expect(mocks.toggle).toHaveBeenCalledWith("agent", controls.agentController);
  expect(controls.abort).toHaveBeenCalledOnce();
  const popout = setup(false, true);
  mocks.handlers.get("cancel-dictation")?.();
  mocks.handlers.get("pause-dictation")?.();
  mocks.handlers.get("on-click-dictate")?.();
  await mocks.toast?.({ action: "confirm_cancel_transcription" });
  expect(popout.abort).not.toHaveBeenCalled();
  expect(popout.pause).not.toHaveBeenCalled();
  expect(popout.resume).not.toHaveBeenCalled();
});

it("only cancels the recording named by a recovery prompt", async () => {
  const controls = setup(true);
  await mocks.toast?.({ action: "cancel_recording_stop" });
  await mocks.toast?.({
    action: "cancel_recording_stop",
    proposalId: "stale-owner",
  });
  controls.isStoppingRef.current = false;
  await mocks.toast?.({
    action: "cancel_recording_stop",
    proposalId: "old-owner",
  });
  expect(controls.abort).not.toHaveBeenCalled();
  controls.isStoppingRef.current = true;
  await mocks.toast?.({
    action: "cancel_recording_stop",
    proposalId: "old-owner",
  });
  expect(controls.abort).toHaveBeenCalledOnce();
  controls.nativeStartOwnerRef.current = null;
  await mocks.toast?.({
    action: "cancel_recording_stop",
    proposalId: "old-owner",
  });
  expect(controls.abort).toHaveBeenCalledOnce();
  const popout = setup(false);
  await mocks.toast?.({
    action: "cancel_recording_stop",
    proposalId: "old-owner",
  });
  expect(popout.abort).not.toHaveBeenCalled();
});

it("scopes always-allow permissions to the conversation and resolves the request", () => {
  setup(true);
  mocks.handlers.get("overlay-resolve-permission")?.({
    permissionId: "permission",
    status: "allowed",
    alwaysAllow: true,
  } as never);
  expect(mocks.alwaysAllow).toHaveBeenCalledWith({
    toolId: "tool",
    params: { x: 1 },
    allowed: true,
    scope: "conversation:conversation",
  });
  expect(mocks.resolve).toHaveBeenCalledWith("permission", "allowed");
});
