import { describe, expect, it } from "vitest";
import {
  appendTimingSample,
  markPipeline,
  medianTiming,
  type PipelineSummary,
  startPipelineTrace,
  summarizePipeline,
} from "./pipeline-trace";

describe("pipeline trace", () => {
  it("marks stages on the trace", () => {
    const trace = startPipelineTrace(1000);
    markPipeline(trace, "stopped", 1100);
    markPipeline(trace, "transcribed", 1500);
    expect(trace.marks.stopped).toBe(1100);
    expect(trace.marks.transcribed).toBe(1500);
    expect(trace.marks.polished).toBeUndefined();
  });

  it("ignores marks on a missing trace", () => {
    expect(() => markPipeline(null, "stopped", 1100)).not.toThrow();
    expect(() => markPipeline(undefined, "stopped", 1100)).not.toThrow();
  });

  it("summarizes per-stage durations from the stopped mark", () => {
    const trace = startPipelineTrace(1000);
    markPipeline(trace, "stopped", 1100);
    markPipeline(trace, "audioFinalized", 1200);
    markPipeline(trace, "transcribed", 1500);
    const summary = summarizePipeline(trace, 1600);
    expect(summary?.totalMs).toBe(500);
    expect(summary?.stages).toEqual({
      stopped: 0,
      audioFinalized: 100,
      transcribed: 300,
    });
  });

  it("returns null for a missing trace", () => {
    expect(summarizePipeline(null)).toBeNull();
    expect(summarizePipeline(undefined)).toBeNull();
  });

  it("appends samples and caps history per stage", () => {
    const first = appendTimingSample(undefined, {
      totalMs: 500,
      stages: { transcribed: 300 },
    });
    expect(first.samples).toBe(1);
    const second = appendTimingSample(
      first,
      { totalMs: 400, stages: { transcribed: 200 } },
      1,
    );
    expect(second.samples).toBe(2);
    expect(second.stages.transcribed).toEqual([200]);
  });

  it("computes medians for odd, even, and empty inputs", () => {
    expect(medianTiming([])).toBe(0);
    expect(medianTiming([300])).toBe(300);
    expect(medianTiming([300, 100, 200])).toBe(200);
    expect(medianTiming([400, 100, 300, 200])).toBe(250);
  });
});

describe("appendTimingSample bounds the sample list for every cap", () => {
  const summary = (ms: number): PipelineSummary => ({
    stages: { stt: ms },
    totalMs: ms,
  });

  const samplesFor = (cap: number | undefined): number[] => {
    let agg = appendTimingSample(undefined, summary(1), cap as number);
    for (const ms of [2, 3, 4])
      agg = appendTimingSample(agg, summary(ms), cap as number);
    return agg.stages.stt;
  };

  it("caps at a positive bound", () => {
    expect(samplesFor(2)).toEqual([3, 4]);
  });

  it("caps at one rather than at zero", () => {
    // `slice(-0)` is `slice(0)`, which returns the WHOLE array. Before this, a cap of 0
    // -- the value that most plainly means "keep nothing" -- kept everything.
    expect(samplesFor(0)).toEqual([4]);
  });

  it("caps rather than grows on a negative bound", () => {
    expect(samplesFor(-5)).toEqual([4]);
  });

  it("caps on a fractional bound", () => {
    expect(samplesFor(2.9)).toEqual([3, 4]);
  });

  // Both of these push MORE than the default cap, which is the whole point: a cap of
  // "at most 20" also passes when nothing is capping at all, because 4 samples is under 20
  // either way. Thirty samples does not fit unless the cap is real.
  const samplesFor30 = (cap: number): number[] => {
    let agg = appendTimingSample(undefined, summary(1), cap);
    for (let ms = 2; ms <= 30; ms += 1) {
      agg = appendTimingSample(agg, summary(ms), cap);
    }
    return agg.stages.stt;
  };

  it("falls back to the default on NaN", () => {
    // `Math.floor(NaN)` is NaN, so `Math.max(1, ...)` alone leaves this unbounded --
    // `slice(-NaN)` is `slice(0)`. Measured: `[1,2,3].slice(-NaN).length` is 3.
    const kept = samplesFor30(Number.NaN);
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)).toBe(30);
  });

  it("falls back to the default on Infinity", () => {
    expect(samplesFor30(Number.POSITIVE_INFINITY)).toHaveLength(20);
  });

  it("falls back to the default on -Infinity", () => {
    expect(samplesFor30(Number.NEGATIVE_INFINITY)).toHaveLength(20);
  });

  it("uses the default when no cap is given", () => {
    expect(samplesFor(undefined)).toHaveLength(4);
  });
});
