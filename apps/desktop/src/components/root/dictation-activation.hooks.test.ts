import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  state: {
    pendingPillReview: null as object | null,
    assistantInputMode: "voice",
    local: { lastDictatedAt: 0 },
  },
  unlocked: true,
  alert: vi.fn(),
  trackDictation: vi.fn(),
  trackAgent: vi.fn(),
  logger: { info: vi.fn(), verbose: vi.fn() },
}));
vi.mock("react", () => ({ useCallback: (fn: unknown) => fn }));
vi.mock("../../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../../utils/user.utils", () => ({
  getIsDictationUnlocked: () => mocks.unlocked,
}));
vi.mock("../../utils/audio.utils", () => ({ playAlertSound: mocks.alert }));
vi.mock("../../utils/analytics.utils", () => ({
  trackDictationStart: mocks.trackDictation,
  trackAgentStart: mocks.trackAgent,
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import { useRecordingActivation } from "./dictation-activation.hooks";
beforeEach(() => {
  mocks.unlocked = true;
  mocks.state.pendingPillReview = null;
  mocks.state.assistantInputMode = "voice";
  vi.clearAllMocks();
});
it("blocks both modes during pending review", async () => {
  mocks.state.pendingPillReview = {};
  const start = vi.fn();
  const controls = useRecordingActivation(start, vi.fn());
  await controls.startDictationRecording();
  await controls.startAgentRecording();
  expect(start).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledTimes(2);
});
it("switches agent typing to voice before starting and routes stop to the owner", async () => {
  mocks.state.assistantInputMode = "type";
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const controls = useRecordingActivation(start, stop);
  await controls.startAgentRecording();
  expect(mocks.state.assistantInputMode).toBe("voice");
  expect(start).toHaveBeenCalledWith({ mode: "agent" });
  await controls.stopAgentRecording();
  expect(stop).toHaveBeenCalledOnce();
});
it("updates dictation activity only when unlocked", async () => {
  mocks.unlocked = false;
  const start = vi.fn().mockResolvedValue(undefined);
  const controls = useRecordingActivation(start, vi.fn());
  await controls.startDictationRecording();
  expect(start).not.toHaveBeenCalled();
  mocks.unlocked = true;
  await controls.startDictationRecording();
  expect(start).toHaveBeenCalledWith({ mode: "dictate" });
  expect(mocks.trackDictation).toHaveBeenCalledOnce();
  expect(mocks.state.local.lastDictatedAt).toBeGreaterThan(0);
});
