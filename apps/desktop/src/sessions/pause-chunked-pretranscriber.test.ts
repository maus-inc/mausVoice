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
  step = 100,
) => {
  for (let offset = from; offset < audio.length; offset += step) {
    target.push(audio.subarray(offset, offset + step), offset);
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

/** True when `spans` tile `audio` exactly once, in any request order. */
const coversExactly = (spans: Float32Array[], audio: Float32Array): boolean => {
  const remaining = new Set(spans);
  let offset = 0;
  while (offset < audio.length) {
    const span = [...remaining].find(
      (candidate) =>
        offset + candidate.length <= audio.length &&
        candidate.every((value, index) => value === audio[offset + index]),
    );
    if (!span) return false;
    remaining.delete(span);
    offset += span.length;
  }
  return remaining.size === 0;
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

  it("transcribes the unobserved prefix so a late listener still covers the whole recording", async () => {
    // `feed(..., 700)` pins the first observed offset at exactly 700, so the
    // prefix is exactly 700 samples and can be labelled by length alone.
    // Everything else is checked by exact cover, which does not depend on the
    // order the spans happened to be requested in.
    const { transcribe, spans } = recordingTranscriber();
    const labelled: ChunkTranscriber = async (samples, rate, signal) => {
      const result = await transcribe(samples, rate, signal);
      return {
        ...result,
        text: samples.length === 700 ? "prefix" : result.text,
      };
    };
    const target = new PauseChunkedPretranscriber(RATE, labelled, CONFIG);
    feed(target, recording, 700);
    expect(target.chunkCount).toBe(2);

    const result = await target.finish({
      samples: recording,
      sampleRate: RATE,
    });
    // Prefix + two committed spans + tail.
    expect(result?.chunkCount).toBe(4);
    // The prefix is joined first even though its request starts last.
    expect(result?.text.split(" ")[0]).toBe("prefix");
    // The spans tile the recording exactly once: no gap, no overlap, and no
    // audio outside the recording.
    expect(coversExactly(spans, recording)).toBe(true);
  });

  it("keeps the prefix span inside the whole recording and never re-sends the tail", async () => {
    const { transcribe, spans } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording, 700);
    await target.finish({ samples: recording, sampleRate: RATE });
    // Two committed spans, plus the prefix and the tail, and no other audio is
    // ever sent: total length equals the recording exactly.
    expect(spans).toHaveLength(4);
    expect(spans.reduce((sum, span) => sum + span.length, 0)).toBe(
      recording.length,
    );
    expect(spans.some((span) => span.length === 700)).toBe(true);
    expect(spans.at(-1)?.at(-1)).toBe(recording.at(-1));
  });

  it("falls back when the unobserved prefix is longer than one span", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    // Attach after 5.5 s, which is past the 5 s minimum span, so prefixing it
    // would cost more than simply transcribing the whole recording.
    feed(target, recording, 5_500);
    expect(target.chunkCount).toBeGreaterThan(0);
    await expect(
      target.finish({ samples: recording, sampleRate: RATE }),
    ).resolves.toBeNull();
  });

  it("rejects a stream that diverges inside a committed span, not just at its end", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    // Inside the first committed span, far from both its start and the 32
    // samples that the old suffix probe used to check.
    const altered = recording.slice();
    altered.fill(0.123, 3_000, 3_010);
    await expect(
      target.finish({ samples: altered, sampleRate: RATE }),
    ).resolves.toBeNull();
  });

  it("accepts the untouched recording with a zeroed span boundary probe", async () => {
    const { transcribe, spans } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    // The first committed span is still exactly what the stream carried, so
    // the digest check must not reject a legitimate recording.
    await expect(
      target.finish({ samples: recording, sampleRate: RATE }),
    ).resolves.not.toBeNull();
    expect(spans.length).toBeGreaterThan(0);
  });

  it("spends no request on the tail once a committed span has already failed", async () => {
    const transcribe = vi
      .fn<ChunkTranscriber>()
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue({ text: "ok", metadata: {}, warnings: [] });
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording);
    // Let the committed spans run and the first one fail before the user stops.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcribe).toHaveBeenCalled();

    // The result is already doomed, so the whole-recording request the caller
    // makes next is the only one left worth paying for. Only the spans that
    // were already committed before the stop may run, never the tail.
    await expect(
      target.finish({ samples: recording, sampleRate: RATE }),
    ).resolves.toBeNull();
    expect(transcribe).toHaveBeenCalledTimes(target.chunkCount);
  });

  it("spends no request once a later chunk reveals a gap", async () => {
    const { transcribe } = recordingTranscriber();
    const target = new PauseChunkedPretranscriber(RATE, transcribe, CONFIG);
    feed(target, recording, 0, 1_000);
    // Overlaps the previous chunk, so the stream is unusable even though every
    // span committed so far succeeded.
    target.push(recording.subarray(2_100, 2_200), 2_100);
    expect(target.chunkCount).toBeGreaterThan(0);

    // Only the committed spans run. No tail, because a result that gets
    // discarded is not worth a billed request.
    await expect(
      target.finish({ samples: recording, sampleRate: RATE }),
    ).resolves.toBeNull();
    expect(transcribe).toHaveBeenCalledTimes(target.chunkCount);
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
});
