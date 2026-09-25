import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  showToast: vi.fn(),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../actions/toast.actions", () => ({ showToast: mocks.showToast }));
vi.mock("../actions/transcribe.actions", () => ({
  transcribeAudio: mocks.transcribeAudio,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import { BatchTranscriptionSession } from "./batch-transcription-session";

const RATE = 1_000;

/** Speech-like noise at ~0.4 RMS, or near-silence, with a unique seed. */
const segment = (seconds: number, speech: boolean, seed: number) => {
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    const phase = Math.sin(index * 0.7 + seed);
    samples[index] = speech ? 0.4 * phase : 0.0005 * phase;
  }
  return samples;
};

const join = (...parts: Float32Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const recording = join(
  segment(20, true, 1),
  segment(0.6, false, 2),
  segment(20, true, 3),
  segment(0.6, false, 4),
  segment(10, true, 5),
);

/** The handler the session handed to `listenToAudioChunks`, once attached. */
const chunkListener = (): ((samples: number[], offset: number) => void) => {
  const handler = mocks.listen.mock.calls.at(-1)?.[1] as
    | ((event: { payload: { samples: number[]; offset: number } }) => void)
    | undefined;
  if (!handler) throw new Error("no audio_chunk listener was registered");
  return (samples, offset) => handler({ payload: { samples, offset } });
};

/** Streams `audio` in 100-sample frames, the way the recorder emits it. */
const streamRecording = (audio: Float32Array, from = 0) => {
  const emit = chunkListener();
  for (let offset = from; offset < audio.length; offset += 100) {
    emit(Array.from(audio.subarray(offset, offset + 100)), offset);
  }
};

const transcriptionResult = (text: string) => ({
  rawTranscript: text,
  sanitizedTranscript: text,
  metadata: { transcriptionMode: "api", transcriptionDurationMs: 100 },
  warnings: [],
});

/** Samples handed to the provider, in request order. */
const requestedAudio = (): number[] =>
  mocks.transcribeAudio.mock.calls.map(
    (call) => (call[0] as { samples: Float32Array }).samples.length,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(mocks.unlisten);
  mocks.transcribeAudio.mockImplementation(async () =>
    transcriptionResult("span"),
  );
});

describe("BatchTranscriptionSession pretranscription wiring", () => {
  it("listens for audio chunks on start and unlistens on cleanup", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    expect(mocks.listen).toHaveBeenCalledWith(
      "audio_chunk",
      expect.any(Function),
    );
    expect(mocks.unlisten).not.toHaveBeenCalled();

    session.cleanup();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("prefers pretranscription over the whole recording and never requests the whole recording", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(recording);
    mocks.transcribeAudio.mockImplementation(async ({ samples }) =>
      transcriptionResult(`span of ${samples.length}`),
    );

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });
    const lengths = requestedAudio();

    // The spans are joined in the order they were requested, each labelled
    // with the audio it covers.
    expect(result.rawTranscript).toBe(
      lengths.map((length) => `span of ${length}`).join(" "),
    );
    // Two cuts plus the tail, tiling the recording exactly once. No request
    // carries the whole recording, so nothing is transcribed twice.
    expect(lengths).toHaveLength(3);
    expect(lengths).not.toContain(recording.length);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(
      recording.length,
    );
    // The listener is torn down before the tail request goes out.
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("falls through to the whole recording when pretranscription cannot be trusted", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(recording);

    // A diverged stream is rejected by the span check, so the recording is
    // transcribed as one request.
    const altered = recording.slice();
    altered.fill(0.123, 500, 510);
    mocks.transcribeAudio.mockResolvedValue(transcriptionResult("whole"));

    const result = await session.finalize({
      samples: altered,
      sampleRate: RATE,
    });

    expect(result.rawTranscript).toBe("whole");
    expect(requestedAudio().at(-1)).toBe(altered.length);
  });

  it("falls through to the whole recording when a span request fails", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(recording);
    mocks.transcribeAudio.mockImplementation(async ({ samples }) => {
      if (samples.length === recording.length) {
        return transcriptionResult("whole");
      }
      throw new Error("429");
    });

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.rawTranscript).toBe("whole");
    expect(requestedAudio()).toContain(recording.length);
  });

  it("spends no further request when a cancel lands mid-finalize", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(recording);

    let releaseTail = () => {};
    const tailInFlight = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    // Both committed spans answer immediately; the tail parks so the cancel
    // below lands while the last span request is still open.
    let requests = 0;
    mocks.transcribeAudio.mockImplementation(async ({ samples }) => {
      requests += 1;
      if (requests < 3) return transcriptionResult(`span of ${samples.length}`);
      await tailInFlight;
      return transcriptionResult("tail");
    });

    const pending = session.finalize({ samples: recording, sampleRate: RATE });
    await vi.waitFor(() =>
      expect(mocks.transcribeAudio).toHaveBeenCalledTimes(3),
    );
    session.cleanup();
    releaseTail();

    const result = await pending;
    expect(result).toEqual({ rawTranscript: null, metadata: {}, warnings: [] });
    // The tail was already paid for; the cancelled run must not add a
    // whole-recording request on top of it.
    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(3);
    expect(requestedAudio()).not.toContain(recording.length);
  });

  it("keeps recording when the audio_chunk listener fails to attach", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("no event permission"));
    const session = new BatchTranscriptionSession();
    await expect(session.onRecordingStart(RATE)).resolves.toBeUndefined();

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.rawTranscript).toBe("span");
    expect(requestedAudio()).toEqual([recording.length]);
  });

  it("skips the request when the recording carries no audio", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);

    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: RATE,
    });

    expect(result).toEqual({ rawTranscript: null, metadata: {}, warnings: [] });
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("reports a failed whole-recording request as a warning instead of throwing", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    mocks.transcribeAudio.mockRejectedValue(new Error("provider down"));

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toEqual([
      "Transcription failed: Error: provider down",
    ]);
    expect(mocks.showToast).toHaveBeenCalledWith({
      message: "Transcription failed",
      toastType: "error",
    });
  });
  it("aborts a whole-recording request when the dictation is discarded", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    // No pause cut, so the whole-recording path is the one that runs.
    streamRecording(join(segment(3, true, 9)));

    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    mocks.transcribeAudio.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) => {
        seen = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (signal?.aborted) throw signal.reason;
        return transcriptionResult("done");
      },
    );

    const pending = session.finalize({
      samples: recording,
      sampleRate: RATE,
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    // The user discards while inference is still running.
    session.cleanup();
    expect(seen?.aborted).toBe(true);
    release?.();

    // A discard is not a failure, so it must not reach the user as one.
    const result = await pending;
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("re-arms the abort scope for the next recording", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    session.cleanup();

    // A second dictation on the same session must still be able to transcribe.
    await session.onRecordingStart(RATE);
    const result = await session.finalize({
      samples: join(segment(3, true, 8)),
      sampleRate: RATE,
    });
    expect(result.rawTranscript).toBe("span");
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
