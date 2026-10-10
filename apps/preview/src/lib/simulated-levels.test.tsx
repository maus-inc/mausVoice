import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulatedLevels, useSimulatedLevels } from "./simulated-levels";

let container: HTMLDivElement;
let root: Root;
let simulation: ReturnType<typeof useSimulatedLevels>;

const Harness = () => {
  simulation = useSimulatedLevels(24, 120, 3000);
  return <output>{simulation.levels.join(",")}</output>;
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("simulated microphone input", () => {
  it("generates repeatable bounded samples that change across frames", () => {
    const samples = simulatedLevels(24, 2);
    expect(samples).toHaveLength(24);
    expect(samples.every((sample) => sample >= 0 && sample <= 1)).toBe(true);
    expect(samples).toEqual(simulatedLevels(24, 2));
    expect(samples).not.toEqual(simulatedLevels(24, 3));
  });

  it("replaces an active feed and stops at the new deadline", () => {
    act(() => simulation.feed());
    act(() => vi.advanceTimersByTime(1000));
    expect(simulation.levels).toHaveLength(24);
    act(() => simulation.feed());
    expect(vi.getTimerCount()).toBe(2);
    act(() => vi.advanceTimersByTime(2500));
    expect(simulation.levels).toHaveLength(24);
    act(() => vi.advanceTimersByTime(500));
    expect(simulation.levels).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the interval and deadline when the consumer unmounts", () => {
    act(() => simulation.feed());
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
