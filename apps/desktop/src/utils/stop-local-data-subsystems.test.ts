import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { stopLocalDataSubsystems } from "./stop-local-data-subsystems";

beforeEach(() => invoke.mockReset());

it("waits for the keyboard listener before stopping recording", async () => {
  let release!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "stop_key_listener"
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(),
  );
  const stopping = stopLocalDataSubsystems();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "stop_key_listener",
  ]);
  release();
  await stopping;
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "stop_key_listener",
    "stop_recording",
  ]);
});

it("attempts recording stop even when the listener fails and reports failure", async () => {
  const failure = new Error("listener failed");
  invoke.mockImplementation((command: string) =>
    command === "stop_key_listener"
      ? Promise.reject(failure)
      : Promise.resolve(),
  );
  await expect(stopLocalDataSubsystems()).rejects.toBe(failure);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "stop_key_listener",
    "stop_recording",
  ]);
});

it("reports a recording stop failure", async () => {
  const failure = new Error("recording failed");
  invoke.mockImplementation((command: string) =>
    command === "stop_recording" ? Promise.reject(failure) : Promise.resolve(),
  );
  await expect(stopLocalDataSubsystems()).rejects.toBe(failure);
});
