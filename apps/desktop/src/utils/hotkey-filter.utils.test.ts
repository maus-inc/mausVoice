import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateHotkeyTrigger,
  releaseHotkey,
  resetHotkeyFilter,
} from "./hotkey-filter.utils";

describe("evaluateHotkeyTrigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    resetHotkeyFilter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Not recording ────────────────────────────────────────────────────

  it("allows any trigger when not recording", () => {
    const result = evaluateHotkeyTrigger("switch-writing-style-forward", false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("not recording");
  });

  // ── Recording: always allow critical actions ──────────────────────────

  it.each([
    ["dictate", "dictate toggle"],
    ["agent-dictate", "agent dictation"],
    ["cancel-transcription", "cancel"],
  ])("allows %s even while recording", (actionName) => {
    const result = evaluateHotkeyTrigger(actionName, true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("always allowed");
  });

  // ── Recording: debounce style switches ───────────────────────────────

  it("drops a rapid repeat of a style switch while recording", () => {
    const first = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(first.allowed).toBe(true);

    // Immediate repeat should be dropped
    const second = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("debounce");
  });

  it("requires release before the same style switch can fire again", () => {
    const first = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(first.allowed).toBe(true);

    const stillHeld = evaluateHotkeyTrigger(
      "switch-writing-style-forward",
      true,
    );
    expect(stillHeld.allowed).toBe(false);

    releaseHotkey("switch-writing-style-forward");

    // Releasing a modifier/key removes the held guard but must not bypass the
    // short debounce window.
    const stillDebounced = evaluateHotkeyTrigger(
      "switch-writing-style-forward",
      true,
    );
    expect(stillDebounced.allowed).toBe(false);
    expect(stillDebounced.reason).toContain("debounce");

    vi.advanceTimersByTime(300);
    const afterRelease = evaluateHotkeyTrigger(
      "switch-writing-style-forward",
      true,
    );
    expect(afterRelease.allowed).toBe(true);
  });

  // ── Recording: distinct hotkeys pass through ──────────────────────────

  it("allows distinct style switches during recording", () => {
    const first = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(first.allowed).toBe(true);

    const second = evaluateHotkeyTrigger("switch-writing-style-backward", true);
    expect(second.allowed).toBe(true);
  });

  // ── Reset ────────────────────────────────────────────────────────────

  it("resets all state on resetHotkeyFilter", () => {
    evaluateHotkeyTrigger("switch-writing-style-forward", true);
    releaseHotkey("switch-writing-style-forward");
    resetHotkeyFilter();

    const result = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(result.allowed).toBe(true);
  });
});
