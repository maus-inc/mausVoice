import { describe, expect, it, vi } from "vitest";
import { createAudioChunkPump } from "./audio-chunking.utils";

const buildPump = (
  overrides: Partial<{
    sampleRate: number;
    minChunkDurationMs: number;
    maxChunkDurationMs: number;
    maxBufferedSamples: number;
    canSend: () => boolean;
  }> = {},
) => {
  const sent: Array<{ chunk: Float32Array; isLastChunk: boolean }> = [];
  const onError = vi.fn();
  const pump = createAudioChunkPump({
    sampleRate: overrides.sampleRate ?? 16000,
    minChunkDurationMs: overrides.minChunkDurationMs ?? 100,
    maxChunkDurationMs: overrides.maxChunkDurationMs ?? 1000,
    maxBufferedSamples: overrides.maxBufferedSamples,
    canSend: overrides.canSend ?? (() => true),
    sendChunk: (chunk, isLastChunk) => sent.push({ chunk, isLastChunk }),
    onError,
  });
  return { pump, sent, onError };
};

// sampleRate 16000, min 100ms -> 1600 samples, max 1000ms -> 16000 samples.
describe("createAudioChunkPump", () => {
  it("drains exactly one chunk of minSamplesPerChunk on a non-forced flush", () => {
    const { pump, sent } = buildPump();
    pump.pushSamples(new Float32Array(1600));
    pump.flushPendingSamples(false);

    expect(sent).toHaveLength(1);
    expect(sent[0].chunk).toHaveLength(1600);
    expect(sent[0].isLastChunk).toBe(false);
  });

  it("forced final flush emits exactly one isLastChunk=true chunk", () => {
    const { pump, sent } = buildPump();
    pump.pushSamples(new Float32Array(500));
    pump.flushPendingSamples(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].isLastChunk).toBe(true);
  });

  it("pads a short forced chunk up to minSamplesPerChunk", () => {
    const { pump, sent } = buildPump();
    pump.pushSamples(new Float32Array(100));
    pump.flushPendingSamples(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].chunk).toHaveLength(1600);
    expect(sent[0].isLastChunk).toBe(true);
  });

  it("refuses to send when canSend() is false", () => {
    const { pump, sent } = buildPump({ canSend: () => false });
    pump.pushSamples(new Float32Array(5000));
    pump.flushPendingSamples(true);

    expect(sent).toHaveLength(0);
  });

  it("bounds pre-initialization audio buffering", () => {
    const { pump, sent } = buildPump({
      canSend: () => false,
      maxBufferedSamples: 100,
    });
    pump.pushSamples(new Float32Array(80));
    expect(() => pump.pushSamples(new Float32Array(21))).toThrow(
      "Audio startup buffer limit exceeded",
    );
    expect(sent).toHaveLength(0);
  });

  it("drains at max chunk size and buffers the remainder", () => {
    const { pump, sent } = buildPump();
    pump.pushSamples(new Float32Array(16000 * 2 + 800));
    pump.flushPendingSamples(false);

    expect(sent).toHaveLength(2);
    expect(sent[0].chunk).toHaveLength(16000);
    expect(sent[1].chunk).toHaveLength(16000);
    expect(sent.every((s) => s.isLastChunk === false)).toBe(true);

    pump.flushPendingSamples(true);
    expect(sent).toHaveLength(3);
    expect(sent[2].chunk).toHaveLength(1600);
    expect(sent[2].isLastChunk).toBe(true);
  });

  it("keeps a chunk whose send threw, for the next flush", () => {
    // A chunk is drained out of the queue before it goes on the wire, so a
    // `sendChunk` that throws used to drop those samples for good — the
    // connection can recover and the audio in hand is the only copy, yet
    // nothing put it back and the retry flushed silence in its place. That is
    // the worst shape for a dictation: the user hears a gap they cannot
    // explain and the words are simply gone.
    const minSamplesPerChunk = 1600;
    const sent: number[] = [];
    let failNext = true;
    const onError = vi.fn();
    const pump = createAudioChunkPump({
      sampleRate: 16000,
      minChunkDurationMs: 100,
      maxChunkDurationMs: 1000,
      canSend: () => true,
      sendChunk: (chunk) => {
        if (failNext) {
          failNext = false;
          throw new Error("socket closed");
        }
        sent.push(chunk.length);
      },
      onError,
    });

    pump.pushSamples(
      Float32Array.from({ length: minSamplesPerChunk }, () => 1),
    );
    pump.flushPendingSamples();

    expect(onError).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);

    // The retry has to carry the same audio rather than nothing at all.
    pump.flushPendingSamples();
    expect(sent).toEqual([minSamplesPerChunk]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("restores the audio a forced flush padded, not the padding itself", () => {
    // A forced flush stretches a short remainder up to minSamplesPerChunk so the
    // provider gets a frame it accepts. Those zeros are a send-time artefact.
    // Buffering them back makes the queue longer than the count it is tracked
    // by, so the next drain spends its budget on silence: the audio the user
    // actually spoke arrives late, or not at all.
    const sent: number[] = [];
    let failNext = true;
    const onError = vi.fn();
    const pump = createAudioChunkPump({
      sampleRate: 16000,
      minChunkDurationMs: 100,
      maxChunkDurationMs: 1000,
      canSend: () => true,
      sendChunk: (chunk) => {
        if (failNext) {
          failNext = false;
          throw new Error("socket closed");
        }
        // Total amplitude rather than length, so a frame that is mostly padding
        // is distinguishable from one that is mostly speech.
        sent.push(chunk.reduce((total, sample) => total + sample, 0));
      },
      onError,
    });

    pump.pushSamples(Float32Array.from({ length: 100 }, () => 1));
    pump.flushPendingSamples(true);
    expect(onError).toHaveBeenCalledOnce();
    // The frame failed to send; only the empty terminal signal got through.
    expect(sent).toEqual([0]);

    // The user keeps talking, then the forced flush goes out. Both utterances
    // have to be in that one frame, and neither may be diluted by the padding
    // that made the failed attempt acceptable.
    pump.pushSamples(Float32Array.from({ length: 100 }, () => 1));
    pump.flushPendingSamples(true);
    expect(sent).toEqual([0, 200]);
  });
});
