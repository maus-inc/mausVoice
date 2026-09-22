import { describe, expect, it } from "vitest";
import {
  appendTimingSample,
  markPipeline,
  medianTiming,
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
