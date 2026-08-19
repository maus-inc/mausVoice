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
    const result = evaluateHotkeyTrigger("dictate:toggle", false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("not recording");
  });

  // ── Recording: always allow stop/cancel ───────────────────────────────

  it("allows stop triggers even while recording", () => {
    const result = evaluateHotkeyTrigger("dictate:stop", true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("stop/cancel");
  });

  it("allows cancel triggers even while recording", () => {
    const result = evaluateHotkeyTrigger("dictate:cancel", true);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("stop/cancel");
  });

  // ── Recording: debounce identical triggers ────────────────────────────

  it("drops a rapid repeat of the same hotkey while recording", () => {
    // First fire: allowed
    const first = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(first.allowed).toBe(true);

    // Immediate repeat: should be dropped
    const second = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("debounce");
  });

  // ── Recording: release-before-refire ──────────────────────────────────

  it("requires release before the same hotkey can fire again", () => {
    // First press
    const first = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(first.allowed).toBe(true);

    // After debounce window but still held — should be dropped
    // (Can't easily simulate time passage, but the held-key check is independent)
    const afterWindow = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(afterWindow.allowed).toBe(false);

    // Release
    releaseHotkey("dictate:toggle");

    // After release, should fire again
    const afterRelease = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(afterRelease.allowed).toBe(true);
  });

  // ── Recording: distinct hotkeys pass through ──────────────────────────

  it("allows distinct hotkeys during recording", () => {
    const first = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(first.allowed).toBe(true);

    // A different hotkey should pass
    const second = evaluateHotkeyTrigger("style:cycle-forward", true);
    expect(second.allowed).toBe(true);
  });

  // ── Stop/cancel can always fire even when repeatedly triggered ────────

  it("allows stop even when rapidly repeated", () => {
    const first = evaluateHotkeyTrigger("dictate:stop", true);
    expect(first.allowed).toBe(true);

    const second = evaluateHotkeyTrigger("dictate:stop", true);
    expect(second.allowed).toBe(true);
  });

  // ── Reset ────────────────────────────────────────────────────────────

  it("resets all state", () => {
    evaluateHotkeyTrigger("dictate:toggle", true);
    releaseHotkey("dictate:toggle");
    resetHotkeyFilter();

    // After reset, should fire fresh
    const result = evaluateHotkeyTrigger("dictate:toggle", true);
    expect(result.allowed).toBe(true);
  });
});