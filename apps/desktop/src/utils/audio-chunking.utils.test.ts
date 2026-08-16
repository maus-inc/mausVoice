import { describe, expect, it, vi } from "vitest";
import { createAudioChunkPump } from "./audio-chunking.utils";

const buildPump = (overrides: Partial<{
  sampleRate: number;
  minChunkDurationMs: number;
  maxChunkDurationMs: number;
  canSend: () => boolean;
}> = {}) => {
  const sent: Array<{ chunk: Float32Array; isLastChunk: boolean }> = [];
  const onError = vi.fn();
  const pump = createAudioChunkPump({
    sampleRate: overrides.sampleRate ?? 16000,
    minChunkDurationMs: overrides.minChunkDurationMs ?? 100,
    maxChunkDurationMs: overrides.maxChunkDurationMs ?? 1000,
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
    expect(sent[0].chunk.length).toBe(1600);
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
    expect(sent[0].chunk.length).toBe(1600);
    expect(sent[0].isLastChunk).toBe(true);
  });

  it("refuses to send when canSend() is false", () => {
    const { pump, sent } = buildPump({ canSend: () => false });
    pump.pushSamples(new Float32Array(5000));
    pump.flushPendingSamples(true);

    expect(sent).toHaveLength(0);
  });

  it("drains at max chunk size and buffers the remainder", () => {
    const { pump, sent } = buildPump();
    pump.pushSamples(new Float32Array(16000 * 2 + 800));
    pump.flushPendingSamples(false);

    expect(sent).toHaveLength(2);
    expect(sent[0].chunk.length).toBe(16000);
    expect(sent[1].chunk.length).toBe(16000);
    expect(sent.every((s) => s.isLastChunk === false)).toBe(true);

    pump.flushPendingSamples(true);
    expect(sent).toHaveLength(3);
    expect(sent[2].chunk.length).toBe(1600);
    expect(sent[2].isLastChunk).toBe(true);
  });
});
