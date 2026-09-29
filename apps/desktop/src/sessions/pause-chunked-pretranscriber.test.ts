import { describe, expect, it, vi } from "vitest";

import {
  type ChunkTranscriber,
  joinTranscriptSpans,
  PauseChunkedPretranscriber,
} from "./pause-chunked-pretranscriber";

const RATE = 1_000;
const CONFIG = { minChunkSec: 5, minPauseMs: 300 };

/** Speech-like noise at ~0.3 RMS or near-silence, with a unique marker per span. */
const segment = (seconds: number, speech: boolean, seed: number) => {
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    const phase = Math.sin(index * 0.7 + seed);
    samples[index] = speech ? 0.4 * phase : 0.0005 * phase;
  }
  return samples;
};

const concat = (...parts: Float32Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** Feeds `audio` from index `from` on, as a listener that attached late would see it. */
const feed = (
  target: PauseChunkedPretranscriber,
  audio: Float32Array,
  from = 0,
) => {
  for (let offset = from; offset < audio.length; offset += 100) {
    target.push(audio.subarray(offset, offset + 100), offset);
  }
};

const recordingTranscriber = () => {
  const spans: Float32Array[] = [];
  const transcribe = vi.fn<ChunkTranscriber>(async (samples) => {
    spans.push(samples);
    return {
      text: `span${spans.length}`,
      metadata: { transcriptionMode: "api", transcriptionDurationMs: 100 },
      warnings: [`w${spans.length % 2}`],
    };
  });
  return { spans, transcribe };
};

describe("PauseChunkedPretranscriber", () => {
  const recording = concat(
    segment(6, true, 1),
    segment(0.6, false, 2),
    segment(3, true, 3),
    segment(0.6, false, 4),
    segment(4, true, 5),
    segment(0.6, false, 6),
    segment(2, true, 7),
  );

  it("cuts only at pauses after the minimum span and transcribes just the tail at stop", async () => {
    const { spans, transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);

    // 6 s of speech then a pause -> first cut. The next 3 s span is below
    // the 5 s minimum, so it rides along until the pause after the 4 s span.
    expect(target.chunkCount).toBe(2);

    const result = await target.finish({
      samples: recording,
      sampleRate: RATE,
    });
    expect(spans[0].length).toBeGreaterThan(6_000);
    expect(spans[0].length).toBeLessThan(6_600);
    expect(spans[1].length).toBeGreaterThan(5 * RATE);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      text: "span1 span2 span3",
      metadata: { transcriptionMode: "api", transcriptionDurationMs: 300 },
      warnings: ["w1", "w0"],
      chunkCount: 3,
    });
    expect(spans.reduce((sum, span) => sum + span.length, 0)).toBe(
      recording.length,
    );
  });

  it("never cuts continuous speech and defers short recordings to the caller", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    const speech = segment(90, true, 1);
    feed(target, speech);
    expect(target.chunkCount).toBe(0);
    await expect(
      target.finish({ samples: speech, sampleRate: RATE }),
    ).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("falls back when the live stream diverges from the final recording", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    const altered = recording.slice();
    altered.fill(0.123, 5_000, 7_000);
    await expect(
      target.finish({ samples: altered, sampleRate: RATE }),
    ).resolves.toBeNull();
  });

  it("falls back when the final recording is shorter or at another rate", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    await expect(
      target.finish({ samples: recording, sampleRate: 48_000 }),
    ).resolves.toBeNull();

    const second = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(second, recording);
    await expect(
      second.finish({ samples: recording.subarray(0, 100), sampleRate: RATE }),
    ).resolves.toBeNull();
  });

  it("falls back when any span fails", async () => {
    const transcribe = vi
      .fn<ChunkTranscriber>()
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue({ text: "ok", metadata: {}, warnings: [] });
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    await expect(
      target.finish({ samples: recording, sampleRate: RATE }),
    ).resolves.toBeNull();
  });

  it("transcribes spans strictly one at a time and in order", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const transcribe: ChunkTranscriber = async (samples) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(samples.length);
      active -= 1;
      return { text: String(samples.length), metadata: {}, warnings: [] };
    };
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    const result = await target.finish({
      samples: recording,
      sampleRate: RATE,
    });
    expect(maxActive).toBe(1);
    expect(result?.text).toBe(order.join(" "));
  });

  it("ignores audio that arrives after finish or dispose", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    const pending = target.finish({ samples: recording, sampleRate: RATE });
    feed(target, recording);
    await pending;
    expect(transcribe).toHaveBeenCalledTimes(3);

    const disposed = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    disposed.dispose();
    feed(disposed, recording);
    expect(disposed.chunkCount).toBe(0);
  });

  it("aborts the in-flight span and never starts queued spans on dispose", async () => {
    const signals: AbortSignal[] = [];
    const transcribe = vi.fn<ChunkTranscriber>(
      (_samples, _rate, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    expect(target.chunkCount).toBe(2);
    await Promise.resolve();
    expect(transcribe).toHaveBeenCalledTimes(1);

    target.dispose();
    expect(signals[0].aborted).toBe(true);
    expect(target.isDisposed).toBe(true);
    expect(
      await target.finish({ samples: recording, sampleRate: RATE }),
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("aligns a stream whose listener attached after capture started", async () => {
    const { transcribe, spans } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording, 700);
    expect(target.chunkCount).toBe(2);

    const result = await target.finish({
      samples: recording,
      sampleRate: RATE,
    });
    const covered = spans.reduce((sum, span) => sum + span.length, 0);
    expect(covered).toBe(recording.length - 700);
    expect(spans.at(-1)?.at(-1)).toBe(recording.at(-1));
    expect(result?.chunkCount).toBe(3);
    expect(result?.metadata.transcriptionDurationMs).toBe(300);
  });

  it("disables itself on a gap or a chunk without an offset", async () => {
    const gapped = new PauseChunkedPretranscriber(
      RATE,
      recordingTranscriber().transcribe,
      CONFIG,
    );
    gapped.push(recording.subarray(0, 100), 0);
    gapped.push(recording.subarray(200, 300), 200);
    feed(gapped, recording, 300);
    expect(gapped.chunkCount).toBe(0);
    expect(
      await gapped.finish({ samples: recording, sampleRate: RATE }),
    ).toBeNull();

    const unaligned = new PauseChunkedPretranscriber(
      RATE,
      recordingTranscriber().transcribe,
      CONFIG,
    );
    unaligned.push(recording.subarray(0, 100), null);
    feed(unaligned, recording, 100);
    expect(unaligned.chunkCount).toBe(0);
  });

  it("adapts to a noisy floor instead of treating the whole room as speech", () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    const noisy = (seconds: number, speech: boolean, seed: number) =>
      segment(seconds, speech, seed).map(
        (value, index) => value + 0.02 * Math.sin(index * 1.3 + seed),
      );
    feed(
      target,
      concat(noisy(6, true, 1), noisy(0.6, false, 2), noisy(1, true, 3)),
    );
    expect(target.chunkCount).toBe(1);
  });
});

describe("joinTranscriptSpans", () => {
  it("joins spaced scripts with one space and skips empty spans", () => {
    expect(joinTranscriptSpans([" Hello there. ", "", "How are you?"])).toBe(
      "Hello there. How are you?",
    );
  });

  it("joins scripts written without spaces directly", () => {
    expect(joinTranscriptSpans(["今日は。", "元気です"])).toBe(
      "今日は。元気です",
    );
    expect(joinTranscriptSpans(["สวัสดี", "ครับ"])).toBe("สวัสดีครับ");
    expect(joinTranscriptSpans(["我们用 API", "处理"])).toBe("我们用 API处理");
    expect(joinTranscriptSpans(["𠀀", "𠀁"])).toBe("𠀀𠀁");
  });

  it("treats fullwidth punctuation as a no-space script but fullwidth Latin and digits as spaced", () => {
    expect(joinTranscriptSpans(["ありがとう！", "Let's ship it."])).toBe(
      "ありがとう！Let's ship it.",
    );
    expect(joinTranscriptSpans(["ＯＳ", "next"])).toBe("ＯＳ next");
    expect(joinTranscriptSpans(["shipped", "２０２６"])).toBe(
      "shipped ２０２６",
    );
    expect(joinTranscriptSpans(["完了（了）", "next"])).toBe("完了（了）next");
  });
});
