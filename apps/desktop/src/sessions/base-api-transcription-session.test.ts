import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({ error: vi.fn(), verbose: vi.fn() }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => logger }));

import {
  BaseApiTranscriptionSession,
  type BaseApiStreamSession,
} from "./base-api-transcription-session";

class TestSession extends BaseApiTranscriptionSession {
  constructor(stream: BaseApiStreamSession) {
    super({ providerLabel: "Test", inferenceDevice: "test" });
    this.streamSession = stream;
  }
  async onRecordingStart(): Promise<void> {}
  supportsStreaming(): boolean {
    return true;
  }
}

beforeEach(() => vi.clearAllMocks());

describe("stream finalization error privacy", () => {
  it("retires a partially captured stream without requesting final transcription", async () => {
    const stream = { finalize: vi.fn(), cleanup: vi.fn() };
    const session = new TestSession(stream);
    const result = await session.finalize({
      samples: [0.5],
      sampleRate: 16000,
      captureFailed: true,
    });
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toContain(
      "Audio capture stopped unexpectedly; recording may be incomplete",
    );
    expect(stream.cleanup).toHaveBeenCalledOnce();
    expect(stream.finalize).not.toHaveBeenCalled();
  });
  it.each([
    new Error("private transcript and access token"),
    "private transcript and access token",
    { message: "private transcript and access token" },
    new Error("Streaming audio connection was lost: private transcript"),
  ])("does not log or persist untrusted provider errors", async (error) => {
    const session = new TestSession({
      finalize: () => Promise.reject(error),
      cleanup: vi.fn(),
    });
    const result = await session.finalize({
      samples: [0.5],
      sampleRate: 16000,
    });
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toEqual(["Test finalization failed"]);
    expect(logger.error).toHaveBeenCalledWith(
      "[Test] Failed to finalize session",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "private transcript",
    );
  });

  it("retains the app's fixed failure reason without logging an exception", async () => {
    const session = new TestSession({
      finalize: () =>
        Promise.reject(new Error("Streaming audio connection was lost")),
      cleanup: vi.fn(),
    });
    const result = await session.finalize({
      samples: [0.5],
      sampleRate: 16000,
    });
    expect(result.warnings).toEqual([
      "Test finalization failed: Streaming audio connection was lost",
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      "[Test] Failed to finalize session",
    );
  });
});
