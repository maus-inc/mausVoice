import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@maus-inc/voice-ai", () => ({
  createAzureStreamingSession: mocks.create,
}));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/user.utils", () => ({
  loadMyEffectiveDictationLanguage: async () => "en",
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => [],
  buildProviderVocabulary: () => ({ terms: [], warning: null }),
  AZURE_PHRASE_LIST_BUDGET: 100,
}));
import { AzureTranscriptionSession } from "./azure-transcription-session";

const createStream = () => ({
  cleanup: vi.fn(),
  finalize: vi.fn(async () => "text"),
  writeAudioChunk: vi.fn<(samples: Float32Array) => void>(),
});
let resolveStreams: Array<(stream: ReturnType<typeof createStream>) => void>;
beforeEach(() => {
  resolveStreams = [];
  mocks.create
    .mockReset()
    .mockImplementation(
      () => new Promise((resolve) => resolveStreams.push(resolve)),
    );
});
afterEach(() => vi.restoreAllMocks());

describe("Azure stream ownership", () => {
  it("cleans up a stale session when an older startup completes last", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const first = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const second = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(2));
    const oldStream = createStream();
    const newStream = createStream();
    resolveStreams[1](newStream);
    await second;
    resolveStreams[0](oldStream);
    await first;
    expect(oldStream.cleanup).toHaveBeenCalledOnce();
    expect(newStream.cleanup).not.toHaveBeenCalled();
    session.writeAudioChunk(new Float32Array([1]));
    expect(newStream.writeAudioChunk).toHaveBeenCalledOnce();
    session.cleanup();
  });

  it("cancels an unresolved provider startup when the owner is discarded", async () => {
    mocks.create.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    session.cleanup();
    await expect(started).resolves.toBeUndefined();
  });

  it.each([0, NaN, 768001])(
    "does not allocate a resampler or start Azure for invalid sample rate %s",
    async (sampleRate) => {
      const session = new AzureTranscriptionSession("key", "region");
      await session.onRecordingStart(sampleRate);
      expect(mocks.create).not.toHaveBeenCalled();
      await expect(
        session.finalize({ samples: [0.5], sampleRate }),
      ).resolves.toMatchObject({ rawTranscript: null });
    },
  );

  it.each([8000, 16000])(
    "preserves Azure's supported %s Hz PCM format",
    async (sampleRate) => {
      const session = new AzureTranscriptionSession("key", "region");
      const started = session.onRecordingStart(sampleRate);
      await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ sampleRate }),
      );
      const stream = createStream();
      resolveStreams[0](stream);
      await started;
      session.writeAudioChunk(new Float32Array([0.25, -0.25]));
      await session.finalize({ samples: [0.25, -0.25], sampleRate });
      expect(stream.writeAudioChunk).toHaveBeenCalledOnce();
      expect(stream.writeAudioChunk).toHaveBeenCalledWith(
        new Float32Array([0.25, -0.25]),
      );
    },
  );

  it("handles an uncommon rate ratio with bounded linear resampling", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(44101);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const stream = createStream();
    resolveStreams[0](stream);
    await started;
    session.writeAudioChunk(new Float32Array(44101).fill(0.25));
    await session.finalize({
      samples: new Float32Array(44101).fill(0.25),
      sampleRate: 44101,
    });
    const output = stream.writeAudioChunk.mock.calls.flatMap(([samples]) =>
      Array.from(samples),
    );
    expect(output).toHaveLength(16000);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16000 }),
    );
  });

  it("resamples 44.1 kHz microphone audio to Azure's supported 16 kHz format", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(44100);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16000 }),
    );
    const stream = createStream();
    resolveStreams[0](stream);
    await started;
    const input = new Float32Array(441).fill(0.25);
    session.writeAudioChunk(input.subarray(0, 200));
    session.writeAudioChunk(input.subarray(200));
    const result = session.finalize({ samples: input, sampleRate: 44100 });
    expect(session.finalize({ samples: input, sampleRate: 44100 })).toBe(
      result,
    );
    await expect(result).resolves.toMatchObject({ rawTranscript: "text" });
    const output = stream.writeAudioChunk.mock.calls.flatMap(([samples]) =>
      Array.from(samples),
    );
    expect(output).toHaveLength(160);
    expect(output.every((sample) => Math.abs(sample - 0.25) < 1e-6)).toBe(true);
    expect(stream.finalize).toHaveBeenCalledOnce();
  });

  it("does not flush a failed capture into the Azure stream", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(12000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const stream = createStream();
    resolveStreams[0](stream);
    await started;
    session.writeAudioChunk(new Float32Array([0.5, 0.5, 0.5]));
    const audio = {
      samples: [0.5, 0.5, 0.5],
      sampleRate: 12000,
      captureFailed: true,
    };
    const finalization = session.finalize(audio);
    expect(session.finalize(audio)).toBe(finalization);
    const result = await finalization;
    expect(await session.finalize(audio)).toEqual(result);
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toContain(
      "Audio capture stopped unexpectedly; recording may be incomplete",
    );
    expect(stream.writeAudioChunk).toHaveBeenCalledOnce();
    expect(stream.finalize).not.toHaveBeenCalled();
    expect(stream.cleanup).toHaveBeenCalledOnce();
  });

  it("flushes the resampling tail before Azure finalization", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(12000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const stream = createStream();
    resolveStreams[0](stream);
    await started;
    session.writeAudioChunk(new Float32Array([0.5, 0.5, 0.5]));
    await session.finalize({ samples: [0.5, 0.5, 0.5], sampleRate: 12000 });
    const chunks = stream.writeAudioChunk.mock.calls.map(
      ([samples]) => samples,
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 1]);
    expect(stream.writeAudioChunk.mock.invocationCallOrder.at(-1)).toBeLessThan(
      stream.finalize.mock.invocationCallOrder[0],
    );
  });

  it("does not let a queued old finalizer flush into a replacement session", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const first = session.onRecordingStart(12000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const oldStream = createStream();
    resolveStreams[0](oldStream);
    await first;
    session.writeAudioChunk(new Float32Array([0.5, 0.5, 0.5]));
    const finalization = session.finalize({
      samples: [0.5, 0.5, 0.5],
      sampleRate: 12000,
    });
    const second = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(2));
    const newStream = createStream();
    resolveStreams[1](newStream);
    await second;
    await expect(finalization).resolves.toMatchObject({ rawTranscript: null });
    expect(oldStream.writeAudioChunk).toHaveBeenCalledOnce();
    expect(oldStream.finalize).not.toHaveBeenCalled();
    expect(newStream.writeAudioChunk).not.toHaveBeenCalled();
    expect(newStream.finalize).not.toHaveBeenCalled();
  });

  it("releases a session that starts after cleanup", async () => {
    const session = new AzureTranscriptionSession("key", "region");
    const started = session.onRecordingStart(16000);
    await vi.waitFor(() => expect(resolveStreams).toHaveLength(1));
    const signal = mocks.create.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    session.cleanup();
    expect(signal.aborted).toBe(true);
    const stream = createStream();
    resolveStreams[0](stream);
    await started;
    expect(stream.cleanup).toHaveBeenCalledOnce();
  });
});
