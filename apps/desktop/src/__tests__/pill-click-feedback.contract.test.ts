import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract: a click on the pill body must produce exactly one sound.
 *
 * The desktop side already plays the start/stop recording clip for the
 * `on-click-dictate` event that a body click emits. When the native pills also
 * emitted a `haptic_feedback` message for the same click, the user heard two
 * sounds per interaction. The recording chime owns this click, so the three
 * platform adapters must stay silent in `ClickAction::Pill` and must stay in
 * agreement with each other.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const PILL_INPUT_FILES = [
  "packages/rust_windows_pill/src/input.rs",
  "packages/rust_macos_pill/src/input.rs",
  "packages/rust_gtk_pill/src/input.rs",
];

const extractPillClickArm = (source: string): string => {
  const marker = "ClickAction::Pill => {";
  const start = source.indexOf(marker);
  expect(start, "ClickAction::Pill arm not found").toBeGreaterThan(-1);

  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced braces in ClickAction::Pill arm");
};

describe("native pill body click feedback", () => {
  it.each(PILL_INPUT_FILES)("emits no haptic thock in %s", (file) => {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const arm = extractPillClickArm(source);

    expect(arm).not.toContain("send_haptic");
  });

  it("still guards a body click while the pill is loading on every platform", () => {
    for (const file of PILL_INPUT_FILES) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const arm = extractPillClickArm(source);

      expect(arm).toContain("can_emit_interaction_feedback");
    }
  });
});
