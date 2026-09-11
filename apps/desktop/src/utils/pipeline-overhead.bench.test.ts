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

const runTraceCycle = (): number => {
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
  return performance.now() - tick;
};

const runControlCycle = (): number => {
  const tick = performance.now();
  return performance.now() - tick;
};

const percentile = (sorted: number[], rank: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * rank))] ?? 0;

describe("pipeline overhead benchmark", () => {
  it("keeps trace cost near timer noise and inside the checked-in budget", () => {
    const iterations = 5000;
    const traceDurations: number[] = [];
    const controlDurations: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      traceDurations.push(runTraceCycle());
      controlDurations.push(runControlCycle());
    }
    traceDurations.sort((a, b) => a - b);
    controlDurations.sort((a, b) => a - b);
    const medianMs = percentile(traceDurations, 0.5);
    const p95Ms = percentile(traceDurations, 0.95);
    const controlMedianMs = percentile(controlDurations, 0.5);
    if (process.env.UPDATE_BASELINE === "1") {
      writeFileSync(
        baselinePath,
        `${JSON.stringify({ medianMs, p95Ms }, null, 2)}\n`,
        "utf8",
      );
      return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      medianMs: number;
      p95Ms: number;
    };
    expect(medianMs).toBeLessThanOrEqual(
      Math.max(baseline.medianMs * 3, controlMedianMs * 10, 0.05),
    );
    expect(p95Ms).toBeLessThanOrEqual(
      Math.max(baseline.p95Ms * 3, controlMedianMs * 20, 0.1),
    );
  });
});
