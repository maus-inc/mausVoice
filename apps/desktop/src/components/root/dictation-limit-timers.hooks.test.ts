import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import { clearOwnedTimer } from "./dictation-timers";
const mocks = vi.hoisted(() => ({
  toast: vi.fn().mockResolvedValue(undefined),
  run: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", () => ({ useCallback: (fn: unknown) => fn }));
vi.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../../actions/toast.actions", () => ({
  showToast: mocks.toast,
  runToast: mocks.run,
}));
vi.mock("../../store", () => ({ getAppState: () => ({}) }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: mocks.warning, error: mocks.error }),
}));
vi.mock("../../utils/user.utils", () => ({
  getMyUserPreferences: () => ({}),
  getTranscriptionPrefs: () => ({ mode: "cloud" }),
}));
vi.mock("../../utils/dictation-limit.utils", () => ({
  DEFAULT_DICTATION_LIMIT_MINUTES: 5,
  shouldEnableDictationLimit: () => true,
  getEffectiveDictationLimitMinutes: () => 5,
  getDictationRecordingTimerDurations: () => ({
    warningDurationMs: 10,
    autoStopDurationMs: 20,
  }),
  getProviderRecordingTimerDurations: (limit: number | null) =>
    limit
      ? { warningDurationMs: 30, autoStopDurationMs: 40 }
      : { warningDurationMs: null, autoStopDurationMs: null },
}));
import { useRecordingLimitTimers } from "./dictation-limit-timers.hooks";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
it("replaces active-audio timers and stops once at the configured limit", async () => {
  const userWarning = { current: null };
  const userStop = { current: null };
  const providerWarning = { current: null };
  const providerStop = { current: null };
  const clearUser = vi.fn(() => {
    clearOwnedTimer(userWarning);
    clearOwnedTimer(userStop);
  });
  const stop = vi.fn().mockResolvedValue(undefined);
  const controls = useRecordingLimitTimers({
    recordingWarningTimerRef: userWarning,
    recordingAutoStopTimerRef: userStop,
    providerWarningTimerRef: providerWarning,
    providerAutoStopTimerRef: providerStop,
    clearUserRecordingTimers: clearUser,
    clearProviderRecordingTimers: vi.fn(),
    sessionRef: { current: null },
    recordingOperationRef: { current: 42 },
    stopRecording: stop,
  });
  controls.startUserRecordingTimers();
  controls.startUserRecordingTimers();
  await vi.advanceTimersByTimeAsync(10);
  expect(mocks.toast).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10);
  expect(stop).toHaveBeenCalledExactlyOnceWith(42);
});
it("keeps the provider wall-clock deadline when user timers are cleared", async () => {
  const userWarning = { current: null };
  const userStop = { current: null };
  const providerWarning = { current: null };
  const providerStop = { current: null };
  const stop = vi.fn().mockResolvedValue(undefined);
  const controls = useRecordingLimitTimers({
    recordingWarningTimerRef: userWarning,
    recordingAutoStopTimerRef: userStop,
    providerWarningTimerRef: providerWarning,
    providerAutoStopTimerRef: providerStop,
    clearUserRecordingTimers: () => {
      clearOwnedTimer(userWarning);
      clearOwnedTimer(userStop);
    },
    clearProviderRecordingTimers: () => {
      clearOwnedTimer(providerWarning);
      clearOwnedTimer(providerStop);
    },
    sessionRef: {
      current: {
        getMaximumRecordingDurationMs: () => 40,
      } as TranscriptionSession,
    },
    recordingOperationRef: { current: 42 },
    stopRecording: stop,
  });
  controls.startUserRecordingTimers();
  controls.startProviderRecordingTimers();
  clearOwnedTimer(userWarning);
  clearOwnedTimer(userStop);
  await vi.advanceTimersByTimeAsync(40);
  expect(stop).toHaveBeenCalledExactlyOnceWith(42);
  expect(mocks.toast).toHaveBeenCalledTimes(2);
});

it("observes a rejected automatic stop", async () => {
  const ref = () => ({ current: null });
  const stop = vi.fn().mockRejectedValue(new Error("stop failed"));
  const controls = useRecordingLimitTimers({
    recordingWarningTimerRef: ref(),
    recordingAutoStopTimerRef: ref(),
    providerWarningTimerRef: ref(),
    providerAutoStopTimerRef: ref(),
    clearUserRecordingTimers: () => undefined,
    clearProviderRecordingTimers: () => undefined,
    sessionRef: { current: null },
    recordingOperationRef: { current: 42 },
    stopRecording: stop,
  });
  controls.startUserRecordingTimers();
  await vi.advanceTimersByTimeAsync(20);
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining("stop failed"),
  );
});

it("does not warn or stop a replacement while old timers remain armed", async () => {
  const operation = { current: 1 };
  const ref = () => ({ current: null });
  const stop = vi.fn().mockResolvedValue(undefined);
  const controls = useRecordingLimitTimers({
    recordingWarningTimerRef: ref(),
    recordingAutoStopTimerRef: ref(),
    providerWarningTimerRef: ref(),
    providerAutoStopTimerRef: ref(),
    clearUserRecordingTimers: () => undefined,
    clearProviderRecordingTimers: () => undefined,
    sessionRef: {
      current: {
        getMaximumRecordingDurationMs: () => 40,
      } as TranscriptionSession,
    },
    recordingOperationRef: operation,
    stopRecording: stop,
  });
  controls.startUserRecordingTimers();
  controls.startProviderRecordingTimers();
  operation.current = 2;
  await vi.advanceTimersByTimeAsync(40);
  expect(stop).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});
