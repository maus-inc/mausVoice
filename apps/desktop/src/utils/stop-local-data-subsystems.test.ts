import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  beginNativeRecording,
  resetNativeRecordingSession,
  currentNativeRecording,
} from "./native-recording-session";
import { stopLocalDataSubsystems } from "./stop-local-data-subsystems";

beforeEach(() => {
  invoke.mockReset();
  resetNativeRecordingSession();
});

/** Open a recording so the stop below has an admission to present. */
const startRecording = async (): Promise<void> => {
  invoke.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(7);
    if (command === "start_recording") {
      return Promise.resolve({ sampleRate: 16_000 });
    }
    return Promise.resolve(new ArrayBuffer(4));
  });
  await beginNativeRecording(null);
};

it("waits for the keyboard listener before stopping recording", async () => {
  await startRecording();
  let release!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "stop_key_listener"
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(new ArrayBuffer(4)),
  );
  const stopping = stopLocalDataSubsystems();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "recording_generation",
    "start_recording",
    "stop_key_listener",
  ]);
  release();
  await stopping;
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "recording_generation",
    "start_recording",
    "stop_key_listener",
    "stop_recording",
    "acknowledge_recording",
  ]);
});

it("attempts recording stop even when the listener fails and reports failure", async () => {
  await startRecording();
  const failure = new Error("listener failed");
  invoke.mockImplementation((command: string) =>
    command === "stop_key_listener"
      ? Promise.reject(failure)
      : Promise.resolve(new ArrayBuffer(4)),
  );
  await expect(stopLocalDataSubsystems()).rejects.toBe(failure);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "recording_generation",
    "start_recording",
    "stop_key_listener",
    "stop_recording",
    "acknowledge_recording",
  ]);
});

it("discards the failed stop's admission and reports the original error", async () => {
  await startRecording();
  const ownerId = currentNativeRecording()!.ownerId;
  const stopError = new Error("audio worker failed");
  const discard = vi
    .fn(() => Promise.resolve())
    .mockRejectedValueOnce(new Error("device held"));
  invoke.mockImplementation((command: string) => {
    if (command === "stop_recording") return Promise.reject(stopError);
    if (command === "discard_recording") return discard();
    return Promise.resolve();
  });
  await expect(stopLocalDataSubsystems()).rejects.toBe(stopError);
  expect(invoke).toHaveBeenCalledWith("discard_recording", {
    ownerId,
    generation: 7,
  });
  await stopLocalDataSubsystems();
  // A successful retry retired the tuple: a second teardown sends no recording IPC.
  await stopLocalDataSubsystems();
  expect(discard).toHaveBeenCalledTimes(2);
  expect(
    invoke.mock.calls.filter(([name]) => name === "stop_recording"),
  ).toHaveLength(1);
  expect(currentNativeRecording()).toBeNull();
});

it("does not authorize a wipe on partial audio before device release", async () => {
  await startRecording();
  const payload = { samples: [0.25], sampleRate: 16_000, captureFailed: true };
  invoke.mockImplementation((command: string) => {
    if (command === "stop_recording") return Promise.resolve(payload);
    if (command === "discard_recording")
      return Promise.reject(new Error("device held"));
    return Promise.resolve();
  });
  await expect(stopLocalDataSubsystems()).rejects.toThrow("device held");
  invoke.mockResolvedValue(null);
  await stopLocalDataSubsystems();
  expect(
    invoke.mock.calls.filter(([command]) => command === "stop_recording"),
  ).toHaveLength(1);
  expect(
    invoke.mock.calls.filter(([command]) => command === "discard_recording"),
  ).toHaveLength(2);
});
