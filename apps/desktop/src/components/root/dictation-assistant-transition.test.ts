import { beforeEach, expect, it, vi } from "vitest";
import type { NativeRecordingLease } from "../../utils/native-recording-lease";
import type { TranscriptionSession } from "../../types/transcription-session.types";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  warning: vi.fn(),
  state: { assistantInputMode: "voice" },
}));
vi.mock("./dictation-recording-intake", () => ({
  stopNativeRecordingForAbort: mocks.stop,
}));
vi.mock("../../store", () => ({
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), warning: mocks.warning }),
}));
import { enterAssistantTypeMode } from "./dictation-assistant-transition";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stop.mockResolvedValue(undefined);
  mocks.state.assistantInputMode = "voice";
});
it("retires native startup before cleaning the session and entering type mode", () => {
  const operationRef = { current: 4 };
  const nativeStartOwnerRef = { current: {} as NativeRecordingLease | null };
  const cleanup = vi.fn();
  const sessionRef = {
    current: { cleanup } as unknown as TranscriptionSession | null,
  };
  mocks.stop.mockImplementationOnce(() => {
    expect(operationRef.current).toBe(5);
    return Promise.resolve();
  });
  const options = {
    operationRef,
    nativeStartOwnerRef,
    sessionRef,
    audioChunkUnlistenRef: { current: null },
    endVolumeDim: vi.fn(),
    clearTimers: vi.fn(),
    resetHotkeys: vi.fn(),
    releaseAudioIntake: vi.fn(),
    clearToneSnapshots: vi.fn(),
    sendIdle: vi.fn().mockResolvedValue(undefined),
  };
  enterAssistantTypeMode(options);
  expect(mocks.stop).toHaveBeenCalledWith(nativeStartOwnerRef);
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    cleanup.mock.invocationCallOrder[0],
  );
  expect(sessionRef.current).toBeNull();
  expect(mocks.state.assistantInputMode).toBe("type");
});
it("does not clear a successor installed while the old lease is released", () => {
  const operationRef = { current: 1 };
  const oldLease = {} as NativeRecordingLease;
  const newLease = {} as NativeRecordingLease;
  const nativeStartOwnerRef = {
    current: oldLease as NativeRecordingLease | null,
  };
  const oldSession = { cleanup: vi.fn() } as unknown as TranscriptionSession;
  const newSession = { cleanup: vi.fn() } as unknown as TranscriptionSession;
  const sessionRef = { current: oldSession as TranscriptionSession | null };
  const oldListener = vi.fn();
  const newListener = vi.fn();
  const audioChunkUnlistenRef = { current: oldListener as (() => void) | null };
  const releaseAudioIntake = vi.fn();
  const clearTimers = vi.fn();
  const sendIdle = vi.fn().mockResolvedValue(undefined);
  mocks.stop.mockImplementationOnce(() => {
    operationRef.current++;
    nativeStartOwnerRef.current = newLease;
    sessionRef.current = newSession;
    audioChunkUnlistenRef.current = newListener;
    return Promise.resolve();
  });
  enterAssistantTypeMode({
    operationRef,
    nativeStartOwnerRef,
    sessionRef,
    audioChunkUnlistenRef,
    endVolumeDim: vi.fn(),
    clearTimers,
    resetHotkeys: vi.fn(),
    releaseAudioIntake,
    clearToneSnapshots: vi.fn(),
    sendIdle,
  });
  expect(nativeStartOwnerRef.current).toBe(newLease);
  expect(sessionRef.current).toBe(newSession);
  expect(oldSession.cleanup).toHaveBeenCalledOnce();
  expect(newSession.cleanup).not.toHaveBeenCalled();
  expect(releaseAudioIntake).toHaveBeenCalledWith(oldListener);
  expect(clearTimers).not.toHaveBeenCalled();
  expect(sendIdle).not.toHaveBeenCalled();
  expect(mocks.state.assistantInputMode).toBe("voice");
});

it("always releases the native lease when auxiliary teardown throws", () => {
  const fail = vi.fn(() => {
    throw new Error("teardown failed");
  });
  const nativeStartOwnerRef = { current: {} as NativeRecordingLease | null };
  const cleanup = vi.fn();
  const sessionRef = {
    current: { cleanup } as unknown as TranscriptionSession | null,
  };
  const operationRef = { current: 0 };
  expect(() =>
    enterAssistantTypeMode({
      operationRef,
      nativeStartOwnerRef,
      sessionRef,
      audioChunkUnlistenRef: { current: null },
      endVolumeDim: fail,
      clearTimers: fail,
      resetHotkeys: fail,
      releaseAudioIntake: fail,
      clearToneSnapshots: fail,
      sendIdle: fail,
    }),
  ).not.toThrow();
  expect(operationRef.current).toBe(1);
  expect(mocks.stop).toHaveBeenCalledWith(nativeStartOwnerRef);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(sessionRef.current).toBeNull();
  expect(mocks.state.assistantInputMode).toBe("type");
  expect(fail).toHaveBeenCalledTimes(6);
});

it("still enters type mode if provider cleanup throws", () => {
  const sessionRef = {
    current: {
      cleanup: () => {
        throw new Error("bad cleanup");
      },
    } as unknown as TranscriptionSession | null,
  };
  expect(() =>
    enterAssistantTypeMode({
      operationRef: { current: 0 },
      nativeStartOwnerRef: { current: null },
      sessionRef,
      audioChunkUnlistenRef: { current: null },
      endVolumeDim: vi.fn(),
      clearTimers: vi.fn(),
      resetHotkeys: vi.fn(),
      releaseAudioIntake: vi.fn(),
      clearToneSnapshots: vi.fn(),
      sendIdle: vi.fn().mockResolvedValue(undefined),
    }),
  ).not.toThrow();
  expect(sessionRef.current).toBeNull();
  expect(mocks.state.assistantInputMode).toBe("type");
  expect(mocks.warning).toHaveBeenCalledWith(
    "Session cleanup failed during type mode switch",
  );
  expect(mocks.warning).not.toHaveBeenCalledWith(
    expect.stringContaining("bad cleanup"),
  );
});
