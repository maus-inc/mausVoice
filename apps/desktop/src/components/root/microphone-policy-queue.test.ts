import { beforeEach, expect, it, vi } from "vitest";
import {
  queueMicrophonePolicyChange,
  syncFiniteMicrophoneLinger,
} from "./microphone-policy-queue";

const setMicrophoneLinger = vi.hoisted(() =>
  vi.fn<(_: number) => Promise<void>>(),
);
vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: { setMicrophoneLinger },
}));

beforeEach(async () => {
  await queueMicrophonePolicyChange(() => {});
  setMicrophoneLinger.mockReset().mockImplementation(async () => {});
});

it("holds a fast start behind a pending policy write and applies it only once", async () => {
  let acknowledge!: () => void;
  setMicrophoneLinger.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const effect = syncFiniteMicrophoneLinger(() => 5_000);
  const start = vi.fn();
  const press = syncFiniteMicrophoneLinger(() => 5_000).then(start);

  expect(setMicrophoneLinger).toHaveBeenCalledWith(5_000);
  expect(start).not.toHaveBeenCalled();
  acknowledge();
  await Promise.all([effect, press]);

  expect(start).toHaveBeenCalledOnce();
  expect(setMicrophoneLinger).toHaveBeenCalledOnce();
});

it("reads the latest setting after a warm transition and honors zero", async () => {
  await syncFiniteMicrophoneLinger(() => 5_000);
  let finishClose!: () => void;
  const close = queueMicrophonePolicyChange(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  );
  let linger: number | null = 5_000;
  const press = syncFiniteMicrophoneLinger(() => linger);
  linger = 0;
  finishClose();
  await Promise.all([close, press]);

  expect(setMicrophoneLinger.mock.calls).toEqual([[5_000], [0]]);
  await syncFiniteMicrophoneLinger(() => null);
  expect(setMicrophoneLinger).toHaveBeenCalledTimes(2);
});

it("does not cache a rejected policy write or block a later retry", async () => {
  setMicrophoneLinger.mockRejectedValueOnce(new Error("IPC failed"));
  await expect(syncFiniteMicrophoneLinger(() => 5_000)).rejects.toThrow(
    "IPC failed",
  );
  await syncFiniteMicrophoneLinger(() => 5_000);
  expect(setMicrophoneLinger.mock.calls).toEqual([[5_000], [5_000]]);
});
