import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  markPipeline,
  startPipelineTrace,
  summarizePipeline,
} from "./pipeline-trace";

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "pipeline-overhead.baseline.json");

// Allow instrumentation up to three times the measured clock-only control cost.
const CONTROL_NOISE_MULTIPLIER = 3;

const overheadLimit = (baselineMs: number, clockControlMs: number): number =>
  Math.max(baselineMs * 1.1 + 0.001, clockControlMs * CONTROL_NOISE_MULTIPLIER);

describe("pipeline overhead benchmark", () => {
  it.each([0.001216, 0.005283])(
    "keeps the budget baseline-bound when clock cost is low (%s ms)",
    (baselineMs) => {
      const limit = overheadLimit(baselineMs, 0.0001);
      expect(limit).toBeCloseTo(baselineMs * 1.1 + 0.001, 10);
      expect(baselineMs * 3).toBeGreaterThan(limit);
    },
  );

  it("scales the noise allowance with measured clock cost rather than a fixed floor", () => {
    expect(overheadLimit(0.001216, 0.01)).toBeCloseTo(0.03, 10);
    expect(overheadLimit(0.001216, 0.02)).toBeCloseTo(0.06, 10);
  });

  it("keeps median and p95 within clock-adjusted baseline budgets", () => {
    // Shared CI runners jitter (GC, neighbours, clock drift): a real
    // regression fails every attempt, while a one-off noisy sample does not.
    // Take the best of three measured attempts against the same budgets.
    let passed = false;
    let last = { medianMs: 0, p95Ms: 0, limitMedian: 0, limitP95: 0 };
    for (let attempt = 0; attempt < 3 && !passed; attempt += 1) {
      last = measureOnce();
      passed = last.medianMs <= last.limitMedian && last.p95Ms <= last.limitP95;
    }
    expect(
      passed,
      `pipeline overhead over budget after 3 attempts: ` +
        `median ${last.medianMs}ms (limit ${last.limitMedian}ms), ` +
        `p95 ${last.p95Ms}ms (limit ${last.limitP95}ms)`,
    ).toBe(true);
  });

  function measureOnce() {
    const iterations = 5000;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const tick = performance.now();
      const trace = startPipelineTrace();
      markPipeline(trace, "stopped");
      markPipeline(trace, "audioFinalized");
      markPipeline(trace, "transcribed");
      markPipeline(trace, "polished");
      markPipeline(trace, "reviewing");
      markPipeline(trace, "inserted");
      markPipeline(trace, "persisted");
      summarizePipeline(trace);
      durations.push(performance.now() - tick);
    }
    // The instrumented path makes 9 performance.now() calls per iteration
    // (start, 7 marks, summarize), so the control makes the same 9. Shared
    // CI runners are slower and noisier than the machine that recorded the
    // checked-in baseline, and one GC pause inside the loop lands in the
    // p95 tail. This floor stops the gate demanding better than 3x bare
    // timing cost on slow hardware, while the checked-in baseline still
    // binds on machines as fast as the author's.
    const control: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const tick = performance.now();
      for (let k = 0; k < 9; k += 1) {
        performance.now();
      }
      control.push(performance.now() - tick);
    }
    durations.sort((a, b) => a - b);
    control.sort((a, b) => a - b);
    const medianMs = durations[Math.floor(iterations / 2)] ?? 0;
    const p95Ms = durations[Math.floor(iterations * 0.95)] ?? 0;
    const controlMedian = control[Math.floor(iterations / 2)] ?? 0;
    const controlP95 = control[Math.floor(iterations * 0.95)] ?? 0;
    if (process.env.UPDATE_BASELINE === "1") {
      writeFileSync(
        baselinePath,
        `${JSON.stringify({ medianMs, p95Ms }, null, 2)}\n`,
        "utf8",
      );
      return {
        medianMs,
        p95Ms,
        limitMedian: Number.POSITIVE_INFINITY,
        limitP95: Number.POSITIVE_INFINITY,
      };
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      medianMs: number;
      p95Ms: number;
    };
    return {
      medianMs,
      p95Ms,
      limitMedian: overheadLimit(baseline.medianMs, controlMedian),
      limitP95: overheadLimit(baseline.p95Ms, controlP95),
    };
  }
});
