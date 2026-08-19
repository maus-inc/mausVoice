import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audioListener: null as
    ((event: { payload: { samples: number[] } }) => void) | null,
  unlisten: vi.fn(),
  deferListen: false,
  resolveListen: null as (() => void) | null,
  sendAudio: vi.fn(),
  finalize: vi.fn().mockResolvedValue("final transcript"),
  cleanup: vi.fn(),
  getWarnings: vi.fn(() => [] as string[]),
  createSession: vi.fn(),
  sessionOptions: null as null | {
    onReady?: () => void;
    onConnectionInterrupted?: () => void;
    onFinalSegment?: (segment: string) => void;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _event: string,
      listener: (event: { payload: { samples: number[] } }) => void,
    ) => {
      mocks.audioListener = listener;
      if (mocks.deferListen) {
        return new Promise<typeof mocks.unlisten>((resolve) => {
          mocks.resolveListen = () => resolve(mocks.unlisten);
        });
      }
      return mocks.unlisten;
    },
  ),
}));

vi.mock("@maus-inc/voice-ai", () => ({
  convertFloat32ToPCM16: (samples: Float32Array) =>
    new Int16Array(samples.length).buffer,
  createGladiaStreamingSession: (options: {
    onReady?: () => void;
    onConnectionInterrupted?: () => void;
    onFinalSegment?: (segment: string) => void;
  }) => {
    mocks.sessionOptions = options;
    return mocks.createSession();
  },
}));

vi.mock("../store", () => ({
  getAppState: () => ({}),
}));

vi.mock("../utils/user.utils", () => ({
  loadMyEffectiveDictationLanguage: vi.fn().mockResolvedValue("en-US"),
}));

vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => ({ sources: [], replacements: [] }),
}));

import { GladiaTranscriptionSession } from "./gladia-transcription-session";

beforeEach(() => {
  mocks.audioListener = null;
  mocks.sessionOptions = null;
  mocks.deferListen = false;
  mocks.resolveListen = null;
  mocks.unlisten.mockClear();
  mocks.sendAudio.mockClear();
  mocks.finalize.mockClear();
  mocks.cleanup.mockClear();
  mocks.getWarnings.mockClear();
  mocks.createSession.mockReset().mockReturnValue({
    sendAudio: mocks.sendAudio,
    finalize: mocks.finalize,
    cleanup: mocks.cleanup,
    getWarnings: mocks.getWarnings,
  });
});

describe("GladiaTranscriptionSession", () => {
  it("buffers audio until the validated live session is ready", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    const onSegment = vi.fn();
    session.setInterimResultCallback(onSegment);

    await session.onRecordingStart(16000);
    expect(mocks.audioListener).not.toBeNull();
    mocks.audioListener?.({
      payload: { samples: Array.from({ length: 320 }, () => 0.25) },
    });
    expect(mocks.sendAudio).not.toHaveBeenCalled();

    mocks.sessionOptions?.onReady?.();
    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.sendAudio.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);

    mocks.sessionOptions?.onConnectionInterrupted?.();
    mocks.audioListener?.({
      payload: { samples: Array.from({ length: 320 }, () => 0.25) },
    });
    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    mocks.sessionOptions?.onReady?.();
    expect(mocks.sendAudio).toHaveBeenCalledTimes(2);

    mocks.sessionOptions?.onFinalSegment?.("committed");
    expect(onSegment).toHaveBeenCalledWith("committed");
  });

  it("returns the provider result and exposes a pause-safe 179-minute cap", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();

    expect(session.getMaximumRecordingDurationMs()).toBe(179 * 60 * 1000);
    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    expect(result).toMatchObject({
      rawTranscript: "final transcript",
      metadata: {
        inferenceDevice: "API • Gladia (Streaming)",
        modelSize: "solaria-1",
        transcriptionMode: "api",
      },
      warnings: [],
    });
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it("hands locally buffered reconnect audio to the SDK before finalizing", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    mocks.sessionOptions?.onConnectionInterrupted?.();
    mocks.audioListener?.({
      payload: { samples: Array.from({ length: 320 }, () => 0.25) },
    });
    expect(mocks.sendAudio).not.toHaveBeenCalled();

    await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });

    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it("removes a listener that resolves after cleanup without starting the SDK", async () => {
    mocks.deferListen = true;
    const session = new GladiaTranscriptionSession("key", null);
    const startPromise = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(mocks.audioListener).not.toBeNull());

    session.cleanup();
    mocks.resolveListen?.();
    await startPromise;

    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("cleans listeners, buffers, and the SDK session idempotently", async () => {
    const session = new GladiaTranscriptionSession("key", null);
    await session.onRecordingStart(16000);
    session.cleanup();
    session.cleanup();

    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
