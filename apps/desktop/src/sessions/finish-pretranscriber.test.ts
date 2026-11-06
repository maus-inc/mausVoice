import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PauseChunkedPretranscriber } from "./pause-chunked-pretranscriber";

const logs = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => logs }));
vi.mock("../actions/transcribe.actions", () => ({ transcribeAudio: vi.fn() }));
vi.mock("../actions/toast.actions", () => ({ showToast: vi.fn() }));

import { finishPretranscriber } from "./batch-transcription-session";

const audio = { samples: [1], sampleRate: 16000 };
const fake = (count: number, finish: ReturnType<typeof vi.fn>) =>
  ({ chunkCount: count, finish }) as unknown as PauseChunkedPretranscriber;

beforeEach(() => vi.clearAllMocks());

describe("finishPretranscriber", () => {
  it("skips absent or empty pretranscribers without logging", async () => {
    const finish = vi.fn();
    await expect(
      finishPretranscriber(null, audio, "cloud", "fallback"),
    ).resolves.toBeNull();
    await expect(
      finishPretranscriber(fake(0, finish), audio, "cloud", "fallback"),
    ).resolves.toBeNull();
    expect(finish).not.toHaveBeenCalled();
    expect(logs.info).not.toHaveBeenCalled();
    expect(logs.warning).not.toHaveBeenCalled();
  });

  it("warns and returns null for an unusable result", async () => {
    const finish = vi.fn().mockResolvedValue(null);
    await expect(
      finishPretranscriber(fake(1, finish), audio, "local", "fallback"),
    ).resolves.toBeNull();
    expect(finish).toHaveBeenCalledExactlyOnceWith(audio);
    expect(logs.warning).toHaveBeenCalledExactlyOnceWith("fallback");
  });

  it("returns the same result and logs its count and length", async () => {
    const result = { text: "hello", chunkCount: 2, metadata: {}, warnings: [] };
    const finish = vi.fn().mockResolvedValue(result);
    await expect(
      finishPretranscriber(fake(2, finish), audio, "cloud", "fallback"),
    ).resolves.toBe(result);
    expect(logs.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^\[cloud\] pretranscribed 2 spans; post-stop wait \d+ms \(5 chars\)$/,
      ),
    );
    expect(logs.warning).not.toHaveBeenCalled();
  });

  it("propagates errors for the session to handle", async () => {
    const error = new Error("aborted");
    const finish = vi.fn().mockRejectedValue(error);
    await expect(
      finishPretranscriber(fake(1, finish), audio, "local", "fallback"),
    ).rejects.toBe(error);
    expect(logs.warning).not.toHaveBeenCalled();
  });
});
