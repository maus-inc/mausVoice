import { describe, expect, it } from "vitest";
import { processFireCombo } from "@maus-inc/desktop-utils/react";

const keys = ["ctrl", "a", "extra"];
const subset = (mask: number) =>
  new Set(keys.filter((_, bit) => mask & (1 << bit)));

// Enumerate every pair of held-key sets, enabled state and prior contamination.
const cases = Array.from({ length: 256 }, (_, n) => ({
  before: n & 7,
  after: (n >> 3) & 7,
  wasDisabled: Boolean(n & 64),
  initial: Boolean(n & 128),
}));

const referenceContamination = (
  previousIncludesAll: boolean,
  currentIncludesAll: boolean,
  currentExact: boolean,
  wasDisabled: boolean,
  initial: boolean,
) => {
  let contaminated = initial;
  if (wasDisabled && currentIncludesAll) contaminated = true;
  if (!previousIncludesAll && currentIncludesAll) contaminated = false;
  if (currentIncludesAll && !currentExact) contaminated = true;
  return contaminated;
};

const referenceTransition = (
  previous: Set<string>,
  current: Set<string>,
  wasDisabled: boolean,
  initial: boolean,
) => {
  const previousIncludesAll = previous.has("ctrl") && previous.has("a");
  const currentIncludesAll = current.has("ctrl") && current.has("a");
  const previousExact = previousIncludesAll && previous.size === 2;
  const currentExact = currentIncludesAll && current.size === 2;
  let contaminated = referenceContamination(
    previousIncludesAll,
    currentIncludesAll,
    currentExact,
    wasDisabled,
    initial,
  );
  const shouldFire =
    previousExact && !currentExact && !currentIncludesAll && !contaminated;
  if (!currentIncludesAll) contaminated = false;
  return { state: { contaminated, previousExact: currentExact }, shouldFire };
};

describe("fire-combo transitions", () => {
  it.each(cases)(
    "preserves transitions for $before → $after, disabled=$wasDisabled, contaminated=$initial",
    ({ before, after, wasDisabled, initial }) => {
      const previous = subset(before),
        current = subset(after);
      const states = new Map();
      const activeIds = new Set<string>();
      const result = processFireCombo({
        combo: ["CTRL", "a", "a"],
        previous,
        current,
        wasDisabled,
        states,
        activeIds,
        stateKey: "test",
        previousState: { contaminated: initial, previousExact: false },
      });
      expect(result).toEqual(
        referenceTransition(previous, current, wasDisabled, initial),
      );
      expect(states.get("test")).toEqual(result.state);
      expect(activeIds).toEqual(new Set(["test"]));
    },
  );
});
