// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "./tool-permission.utils";

/**
 * The always-allow key a scope and tool id write.
 *
 * Mirrors the module's own key layout so a test cannot pass by reading a key
 * the module never writes.
 */
const key = (scope: string, toolId: string): string =>
  `tool_always_allow:${scope}:${toolId}`;

beforeEach(() => {
  window.localStorage.clear();
});

describe("always-allow scoping", () => {
  it("keeps a chat tool's grant inside the conversation that made it", () => {
    setToolAlwaysAllow("run_terminal_command", true, "conversation:alpha");

    expect(
      getToolAlwaysAllow("run_terminal_command", "conversation:alpha"),
    ).toBe(true);
    // The shipping behaviour before this branch, and the one that matters: a
    // grant made in one conversation does not arm another.
    expect(
      getToolAlwaysAllow("run_terminal_command", "conversation:beta"),
    ).toBe(false);
  });

  it("carries a computer use grant across conversations", () => {
    setToolAlwaysAllow("computer_use:click", true, "conversation:alpha");

    // The reason computer use opts into the action scope: the same question
    // about the same action type would otherwise be asked on every single turn.
    expect(getToolAlwaysAllow("computer_use:click", "conversation:beta")).toBe(
      true,
    );
  });

  it("does not let one tool's grant answer for another", () => {
    setToolAlwaysAllow("computer_use:click", true, "conversation:alpha");

    expect(getToolAlwaysAllow("computer_use:type", "conversation:beta")).toBe(
      false,
    );
  });

  it("drops every scope of a computer use grant on revoke", () => {
    setToolAlwaysAllow("computer_use:click", true, "conversation:alpha");
    expect(getToolAlwaysAllow("computer_use:click", "conversation:alpha")).toBe(
      true,
    );

    setToolAlwaysAllow("computer_use:click", false, "conversation:alpha");

    // A revoke that left the action grant behind would report the tool as no
    // longer always allowed while still executing without asking.
    expect(getToolAlwaysAllow("computer_use:click", "conversation:alpha")).toBe(
      false,
    );
    expect(getToolAlwaysAllow("computer_use:click", "conversation:beta")).toBe(
      false,
    );
    expect(
      window.localStorage.getItem(key("action", "computer_use:click")),
    ).toBe(null);
  });

  it("ignores an action grant an older build left for a chat tool", () => {
    // The write path gates on the tool id, so a fresh grant for a chat tool never
    // reaches the action scope. This covers the other direction: a build that did
    // write those keys has already put them in people's local storage, and the
    // read has to refuse them or a previously global exemption survives the
    // upgrade that was meant to remove it.
    window.localStorage.setItem(key("action", "run_terminal_command"), "true");

    expect(
      getToolAlwaysAllow("run_terminal_command", "conversation:beta"),
    ).toBe(false);
  });

  it("still honours a legacy unscoped grant", () => {
    window.localStorage.setItem("tool_always_allow:computer_use:click", "true");
    expect(getToolAlwaysAllow("computer_use:click", "conversation:alpha")).toBe(
      true,
    );
  });

  it("reads the global scope when the caller names none", () => {
    // The default is the whole install rather than one conversation, so a caller
    // that forgets the argument gets the widest reading. Nothing in the app
    // currently reads it that way, which is why this is pinned by a test rather
    // than left to the reader to infer from the signature.
    window.localStorage.setItem(key("global", "paste"), "true");

    expect(getToolAlwaysAllow("paste")).toBe(true);
    expect(getToolAlwaysAllow("paste", "conversation:alpha")).toBe(true);
  });

  it("reports no grant at the default scope when the tool was never granted", () => {
    expect(getToolAlwaysAllow("paste")).toBe(false);
    expect(getToolAlwaysAllow("computer_use:click")).toBe(false);
  });
});
