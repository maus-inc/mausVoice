import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  beginNativeRecording,
  resetNativeRecordingSession,
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

it("reports a recording stop failure", async () => {
  await startRecording();
  const failure = new Error("recording failed");
  invoke.mockImplementation((command: string) =>
    command === "stop_recording" ? Promise.reject(failure) : Promise.resolve(),
  );
  await expect(stopLocalDataSubsystems()).rejects.toBe(failure);
});
