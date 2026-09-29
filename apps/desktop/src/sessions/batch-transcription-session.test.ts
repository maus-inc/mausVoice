import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  showToast: vi.fn(),
}));

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

/**
 * The component owns the single `audio_chunk` registration, so a cloud
 * session receives live samples through `writeAudioChunk` together with
 * their absolute sample index. These cover the session half of that contract;
 * registration and teardown belong to `dictation-recording-intake.test.ts`.
 */
const streamRecording = (
  session: BatchTranscriptionSession,
  audio: Float32Array,
  from = 0,
) => {
  for (let offset = from; offset < audio.length; offset += 100) {
    session.writeAudioChunk(audio.subarray(offset, offset + 100), offset);
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
  mocks.transcribeAudio.mockImplementation(async () =>
    transcriptionResult("span"),
  );
});

describe("BatchTranscriptionSession pretranscription wiring", () => {
  it("prefers pretranscription over the whole recording and never requests the whole recording", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(session, recording);
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
  });

  it("falls through to the whole recording when pretranscription cannot be trusted", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(session, recording);

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
    streamRecording(session, recording);
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

  it("cancels an in-flight span before issuing the whole-recording fallback", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(session, recording);

    // The first committed span parks until its abort signal fires, the way a
    // real provider request unwinds on cancellation. It must be released by
    // the doomed pretranscriber, before the fallback request is issued.
    let requests = 0;
    let open = 0;
    let maxOpen = 0;
    const order: string[] = [];
    mocks.transcribeAudio.mockImplementation(async ({ samples, signal }) => {
      requests += 1;
      const isSpan = samples.length < recording.length;
      if (!isSpan) {
        order.push("whole:open");
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        open -= 1;
        return transcriptionResult("whole");
      }
      order.push("span:open");
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      try {
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            order.push("span:aborted");
            reject(new Error("aborted"));
          });
        });
        return transcriptionResult("span");
      } finally {
        open -= 1;
      }
    });

    // Let the first committed span reach the provider, so there is a billed
    // request actually in flight when the user stops.
    await vi.waitFor(() => expect(order).toContain("span:open"));

    // The live stream diverges from the final recording, so pretranscription
    // is doomed and the caller must fall back to the whole recording.
    const diverged = recording.slice();
    diverged.fill(0.4321, 0, 500);

    const result = await session.finalize({
      samples: diverged,
      sampleRate: RATE,
    });

    // The span was cancelled and had fully unwound before the fallback went
    // out, so the two never overlap and the user is billed for one of them.
    expect(order).toEqual(["span:open", "span:aborted", "whole:open"]);
    expect(maxOpen).toBe(1);
    expect(result.rawTranscript).toBe("whole");
  });

  it("spends no further request when a cancel lands mid-finalize", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    streamRecording(session, recording);

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
    streamRecording(session, join(segment(3, true, 9)));

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
