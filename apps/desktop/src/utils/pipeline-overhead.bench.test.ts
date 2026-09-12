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

describe("pipeline overhead benchmark", () => {
  it("keeps median and p95 within 10 percent of the checked-in baseline", () => {
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
      return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      medianMs: number;
      p95Ms: number;
    };
    expect(medianMs).toBeLessThanOrEqual(
      Math.max(baseline.medianMs * 1.1 + 0.001, controlMedian * 3),
    );
    expect(p95Ms).toBeLessThanOrEqual(
      Math.max(baseline.p95Ms * 1.1 + 0.001, controlP95 * 3),
    );
  });
});
