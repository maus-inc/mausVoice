import type { Tone } from "@maus-inc/types";
import { describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getSortedExistingTones } from "./tone.utils";

const tone = (id: string, createdAt: number): Tone => ({
  id,
  name: id,
  promptTemplate: "prompt",
  isSystem: false,
  createdAt,
  sortOrder: 0,
});

describe("getSortedExistingTones", () => {
  it("returns sorted usable records, excluding deprecated and unresolvable IDs", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.toneById = {
      older: tone("older", 1),
      newer: tone("newer", 2),
      obsolete: { ...tone("obsolete", 3), isDeprecated: true },
      wrongKey: tone("missing", 4),
    };
    expect(getSortedExistingTones(state).map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ]);
  });
});
