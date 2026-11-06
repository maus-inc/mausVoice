import { beforeEach, expect, it, vi } from "vitest";
import type { NativeRecordingLease } from "../../utils/native-recording-lease";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn().mockResolvedValue(undefined),
  runToast: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  state: { activeRecordingMode: "dictate" },
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("react-intl", () => ({
  useIntl: () => ({ formatMessage: () => "message" }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../actions/toast.actions", () => ({
  showToast: mocks.toast,
  runToast: mocks.runToast,
}));
vi.mock("../../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ info: mocks.info, error: mocks.error, warning: vi.fn() }),
}));
import { useDictationPause } from "./dictation-pause.hooks";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});
const setup = () => {
  const strategy = {
    setPhase: vi.fn().mockResolvedValue(undefined),
  } as unknown as BaseStrategy;
  const refs = {
    sessionRef: { current: {} as TranscriptionSession | null },
    strategyRef: { current: strategy as BaseStrategy | null },
    operationRef: { current: 1 },
    isPausedRef: { current: false },
    isStoppingRef: { current: false },
    nativeStartOwnerRef: {
      current: {
        pause: () =>
          mocks.invoke("pause_recording", { ownerId: "pause-owner" }),
        resume: () =>
          mocks.invoke("resume_recording", { ownerId: "pause-owner" }),
      } as unknown as NativeRecordingLease | null,
    },
    clearUserRecordingTimers: vi.fn(),
    startUserRecordingTimers: vi.fn(),
  };
  return { strategy, refs, controls: useDictationPause(refs) };
};
it("pauses active-audio timers and restarts them after resuming", async () => {
  const { strategy, refs, controls } = setup();
  await controls.pauseDictation();
  expect(refs.isPausedRef.current).toBe(true);
  expect(refs.clearUserRecordingTimers).toHaveBeenCalledOnce();
  expect(strategy.setPhase).toHaveBeenCalledWith("paused");
  await controls.resumeDictation();
  expect(refs.isPausedRef.current).toBe(false);
  expect(strategy.setPhase).toHaveBeenCalledWith("recording");
  expect(refs.startUserRecordingTimers).toHaveBeenCalledOnce();
});
it("does not let a missing phase reply strand the pause/resume timers", async () => {
  const { strategy, refs, controls } = setup();
  vi.mocked(strategy.setPhase).mockReturnValue(new Promise(() => {}));
  await controls.pauseDictation();
  await controls.resumeDictation();
  expect(refs.isPausedRef.current).toBe(false);
  expect(refs.startUserRecordingTimers).toHaveBeenCalledOnce();
});
it("does not apply an old pause after a replacement starts", async () => {
  let finish!: () => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const { strategy, refs, controls } = setup();
  const oldPause = controls.pauseDictation();
  refs.operationRef.current++;
  refs.sessionRef.current = {} as TranscriptionSession;
  refs.strategyRef.current = { setPhase: vi.fn() } as unknown as BaseStrategy;
  finish();
  await oldPause;
  expect(refs.isPausedRef.current).toBe(false);
  expect(strategy.setPhase).not.toHaveBeenCalled();
  expect(refs.strategyRef.current.setPhase).not.toHaveBeenCalled();
  expect(refs.clearUserRecordingTimers).not.toHaveBeenCalled();
});
it("invalidates a queued pause toast when the recording resumes", async () => {
  const { controls } = setup();
  await controls.pauseDictation();
  const options = mocks.toast.mock.calls[0]?.[0] as {
    isCurrent: () => boolean;
  };
  expect(options.isCurrent()).toBe(true);
  await controls.resumeDictation();
  expect(options.isCurrent()).toBe(false);
});
it("invalidates queued transition errors when the owner or transition changes", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("unsupported"));
  const { refs, controls } = setup();
  await controls.pauseDictation();
  const options = mocks.toast.mock.calls[0]?.[0] as {
    isCurrent: () => boolean;
  };
  expect(options.isCurrent()).toBe(true);
  await controls.pauseDictation();
  expect(options.isCurrent()).toBe(false);
  const newer = mocks.toast.mock.calls[1]?.[0] as {
    isCurrent: () => boolean;
  };
  refs.operationRef.current++;
  expect(newer.isCurrent()).toBe(false);
});
it("coalesces duplicate pause requests for the same operation", async () => {
  let finish!: () => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const { controls } = setup();
  const first = controls.pauseDictation();
  const second = controls.pauseDictation();
  expect(mocks.invoke).toHaveBeenCalledOnce();
  finish();
  await Promise.all([first, second]);
});
it("warns without claiming a failed pause succeeded", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("unsupported"));
  const { strategy, refs, controls } = setup();
  await controls.pauseDictation();
  expect(refs.isPausedRef.current).toBe(false);
  expect(refs.clearUserRecordingTimers).not.toHaveBeenCalled();
  expect(strategy.setPhase).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ toastType: "error" }),
  );
});
it("does not warn a successor about an old pause failure", async () => {
  let fail!: (error: Error) => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      fail = reject;
    }),
  );
  const { refs, controls } = setup();
  const oldPause = controls.pauseDictation();
  refs.operationRef.current++;
  fail(new Error("old failure"));
  await oldPause;
  expect(mocks.toast).not.toHaveBeenCalled();
});
