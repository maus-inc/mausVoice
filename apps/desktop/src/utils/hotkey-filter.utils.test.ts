import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateHotkeyTrigger,
  releaseHotkey,
  resetHotkeyFilter,
} from "./hotkey-filter.utils";

describe("evaluateHotkeyTrigger", () => {
  beforeEach(() => {
    resetHotkeyFilter();
  });

  // ── Not recording ────────────────────────────────────────────────────

  it("allows any trigger when not recording", () => {
    const result = evaluateHotkeyTrigger("switch-writing-style-forward", false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("not recording");
  });

  // ── Recording: always allow critical actions ──────────────────────────

  it("allows dictate toggle even while recording", () => {
    const result = evaluateHotkeyTrigger("dictate", true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("always allowed");
  });

  it("allows agent-dictate even while recording", () => {
    const result = evaluateHotkeyTrigger("agent-dictate", true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("always allowed");
  });

  it("allows cancel-transcription even while recording", () => {
    const result = evaluateHotkeyTrigger("cancel-transcription", true);
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

    const stillHeld = evaluateHotkeyTrigger("switch-writing-style-forward", true);
    expect(stillHeld.allowed).toBe(false);

    releaseHotkey("switch-writing-style-forward");

    const afterRelease = evaluateHotkeyTrigger("switch-writing-style-forward", true);
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