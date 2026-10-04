import { describe, expect, it } from "vitest";

import { drainSamples } from "./audio-buffer.utils";

const chunk = (...values: number[]) => new Float32Array(values);

/**
 * The queue entry at an index. `drainSamples` is expected to leave the
 * remainder queued, so an empty read there is the function failing, and it is
 * reported as such rather than asserted away with `!` -- which handed
 * `Array.from` an `undefined` and surfaced as a `TypeError` naming neither the
 * index nor the call.
 */
const queued = <T>(queue: readonly T[], index: number): T => {
  const entry = queue[index];
  if (entry === undefined) {
    throw new Error(
      `Expected a queued chunk at index ${index}, queue holds ${queue.length}`,
    );
  }
  return entry;
};

describe("drainSamples", () => {
  it("returns an empty buffer and consumes nothing when the target is not positive", () => {
    const pending = [chunk(1, 2, 3)];
    const counter = { value: 3 };

    expect(drainSamples(pending, counter, 0)).toHaveLength(0);
    expect(drainSamples(pending, counter, -5)).toHaveLength(0);
    expect(pending).toHaveLength(1);
    expect(counter.value).toBe(3);
  });

  it("consumes whole chunks when they fit inside the target", () => {
    const pending = [chunk(1, 2), chunk(3, 4)];
    const counter = { value: 4 };

    expect(Array.from(drainSamples(pending, counter, 4))).toEqual([1, 2, 3, 4]);
    expect(pending).toHaveLength(0);
    expect(counter.value).toBe(0);
  });

  it("splits a chunk that is larger than the target and keeps the remainder queued", () => {
    const pending = [chunk(1, 2, 3, 4, 5)];
    const counter = { value: 5 };

    expect(Array.from(drainSamples(pending, counter, 2))).toEqual([1, 2]);
    expect(Array.from(queued(pending, 0))).toEqual([3, 4, 5]);
    expect(counter.value).toBe(3);
  });

  it("returns only what was available when the queue underruns", () => {
    const pending = [chunk(1, 2)];
    const counter = { value: 2 };

    expect(Array.from(drainSamples(pending, counter, 8))).toEqual([1, 2]);
    expect(pending).toHaveLength(0);
    expect(counter.value).toBe(0);
  });

  it("never drives the pending counter below zero", () => {
    const pending = [chunk(1, 2, 3)];
    const counter = { value: 1 };

    drainSamples(pending, counter, 3);

    expect(counter.value).toBe(0);
  });
});
