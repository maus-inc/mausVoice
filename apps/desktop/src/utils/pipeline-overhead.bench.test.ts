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
    durations.sort((a, b) => a - b);
    const medianMs = durations[Math.floor(iterations / 2)] ?? 0;
    const p95Ms = durations[Math.floor(iterations * 0.95)] ?? 0;
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
    expect(medianMs).toBeLessThanOrEqual(baseline.medianMs * 1.1 + 0.001);
    expect(p95Ms).toBeLessThanOrEqual(baseline.p95Ms * 1.1 + 0.001);
  });
});
