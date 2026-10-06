// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { COMPUTER_USE_ACTION_TYPES } from "@maus-inc/types";
import type { ComputerUseAction } from "@maus-inc/types";

import {
  classifyComputerUseAction,
  needsComputerUseApproval,
  REQUIRES_APPROVAL,
} from "./computer-use-risk";

/**
 * One instance of every member of the action union.
 *
 * The table is built from `COMPUTER_USE_ACTION_TYPES` rather than written out,
 * so a new action the vocabulary gains fails this test until it is classified
 * and its approval decision is written down. That is the whole point of the
 * file: an unclassified action would otherwise fall through both switches and
 * reach the loop with no description to show the user.
 */
const oneOfEach = (): readonly ComputerUseAction[] => [
  { type: "screenshot" },
  { type: "cursor_position" },
  { type: "zoom", region: { x0: 0, y0: 0, x1: 10, y1: 10 } },
  { type: "move", x: 4, y: 5 },
  { type: "scroll", direction: "down", amount: 120 },
  { type: "type", text: "hi" },
  { type: "key", keys: ["ctrl", "c"] },
  { type: "key_down", keys: ["shift"] },
  { type: "key_up", keys: ["shift"] },
  { type: "click", x: 960, y: 540 },
  { type: "mouse_down" },
  { type: "mouse_up" },
  { type: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 },
  { type: "wait", ms: 500 },
  { type: "unsupported", providerName: "acme", reason: "no such member" },
];

const actions = oneOfEach();

const byType = new Map(actions.map((action) => [action.type, action]));

describe("classifyComputerUseAction", () => {
  it("covers every action the vocabulary defines", () => {
    expect([...byType.keys()].sort()).toEqual(
      [...COMPUTER_USE_ACTION_TYPES].sort(),
    );
  });

  it("returns a tier and a summary for every action", () => {
    for (const action of actions) {
      const classified = classifyComputerUseAction(action);
      expect(classified.risk, action.type).toMatch(
        /^(low|medium|high|critical)$/,
      );
      expect(classified.summary.length, action.type).toBeGreaterThan(0);
    }
  });

  it("never leaves an action without a description, whatever the tier", () => {
    for (const action of actions) {
      expect(classifyComputerUseAction(action).summary, action.type).toContain(
        " ",
      );
    }
  });

  it("says where a click lands and which button it uses", () => {
    expect(classifyComputerUseAction(byType.get("click")!).summary).toBe(
      "Click 1 time at 960, 540 with the left button",
    );
    expect(
      classifyComputerUseAction({
        type: "click",
        x: 10,
        y: 20,
        button: "right",
        clicks: 2,
      }).summary,
    ).toBe("Click 2 times at 10, 20 with the right button");
  });

  it("names the modifiers a click is held with", () => {
    expect(
      classifyComputerUseAction({
        type: "click",
        x: 1,
        y: 2,
        modifiers: ["ctrl", "shift"],
      }).summary,
    ).toContain("while holding ctrl and shift");
  });

  it("counts the characters a type will send", () => {
    expect(
      classifyComputerUseAction({ type: "type", text: "abc" }).summary,
    ).toBe("Type 3 characters into whatever has focus");
    expect(classifyComputerUseAction({ type: "type", text: "a" }).summary).toBe(
      "Type 1 character into whatever has focus",
    );
  });

  it("reads a repeated key as a repeat rather than one press", () => {
    expect(
      classifyComputerUseAction({ type: "key", keys: ["enter"], repeat: 3 })
        .summary,
    ).toBe("Press enter 3 times");
  });

  it("rates every action that changes the screen or the pointer as high", () => {
    for (const type of [
      "click",
      "type",
      "key",
      "key_down",
      "key_up",
      "drag",
      "mouse_down",
      "mouse_up",
    ] as const) {
      expect(classifyComputerUseAction(byType.get(type)!).risk, type).toBe(
        "high",
      );
    }
  });

  it("rates scrolling a tier below a click", () => {
    expect(classifyComputerUseAction(byType.get("scroll")!).risk).toBe(
      "medium",
    );
    expect(classifyComputerUseAction(byType.get("click")!).risk).toBe("high");
  });

  it("rates a pointer move as medium, because it decides where the next click lands", () => {
    // `move` is in the approval set. At `low` it would have been incoherent:
    // it would ask, then describe the action as reversible and show no warning,
    // which is the one combination a user cannot act on sensibly.
    expect(REQUIRES_APPROVAL.has("move")).toBe(true);
    expect(classifyComputerUseAction(byType.get("move")!).risk).toBe("medium");
  });

  it("rates every action that only reads as low", () => {
    for (const type of [
      "screenshot",
      "cursor_position",
      "zoom",
      "wait",
      "unsupported",
    ] as const) {
      expect(classifyComputerUseAction(byType.get(type)!).risk, type).toBe(
        "low",
      );
    }
  });

  it("carries a warning on every action above low", () => {
    for (const action of actions) {
      const classified = classifyComputerUseAction(action);
      if (classified.risk === "low") {
        continue;
      }
      expect(classified.warning, action.type).toBeTruthy();
    }
  });

  it("describes a member this provider cannot do without blaming the user", () => {
    const classified = classifyComputerUseAction({
      type: "unsupported",
      providerName: "acme",
      reason: "no such member",
    });
    expect(classified.risk).toBe("low");
    expect(classified.summary).toContain("cannot do");
  });
});

describe("needsComputerUseApproval", () => {
  it("asks for every action in the approval set", () => {
    for (const type of REQUIRES_APPROVAL) {
      expect(needsComputerUseApproval(byType.get(type)!), type).toBe(true);
    }
  });

  it("asks before the pointer is merely moved, because a pointer over a button decides the next click", () => {
    expect(REQUIRES_APPROVAL.has("move")).toBe(true);
    expect(needsComputerUseApproval({ type: "move", x: 1, y: 2 })).toBe(true);
  });

  it("runs read-only actions without asking", () => {
    for (const type of [
      "screenshot",
      "cursor_position",
      "zoom",
      "wait",
    ] as const) {
      expect(REQUIRES_APPROVAL.has(type), type).toBe(false);
      expect(needsComputerUseApproval(byType.get(type)!), type).toBe(false);
    }
  });

  it("decides an action and describes it from the same tier table", () => {
    for (const action of actions) {
      const needs = needsComputerUseApproval(action);
      const risk = classifyComputerUseAction(action).risk;
      if (needs) {
        expect(risk, action.type).not.toBe("low");
      }
    }
  });

  /**
   * The other direction, and the one that matters. Written out rather than
   * derived from the set, so removing a member from `REQUIRES_APPROVAL` fails
   * here instead of quietly letting that action run with no prompt. The
   * read-only actions are the only exemption and they are listed by name.
   */
  it("asks for every action that is not read-only", () => {
    const READ_ONLY = new Set([
      "screenshot",
      "cursor_position",
      "zoom",
      "wait",
      "unsupported",
    ]);
    for (const action of actions) {
      const needs = needsComputerUseApproval(action);
      if (READ_ONLY.has(action.type)) {
        expect(needs, action.type).toBe(false);
      } else {
        expect(needs, action.type).toBe(true);
      }
    }
  });

  it.each([
    ["scroll", { type: "scroll", direction: "down", amount: 120 } as const],
    ["click", { type: "click", x: 1, y: 2 } as const],
    ["type", { type: "type", text: "hi" } as const],
    ["drag", { type: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 } as const],
    ["key", { type: "key", keys: ["enter"] } as const],
    ["key_down", { type: "key_down", keys: ["shift"] } as const],
    ["mouse_down", { type: "mouse_down" } as const],
  ] as const)("asks before a %s", (type, action) => {
    expect(needsComputerUseApproval(action as ComputerUseAction), type).toBe(
      true,
    );
  });
});
