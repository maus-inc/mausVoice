import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

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
const PILL_INPUT_FILES = [
  "packages/rust_windows_pill/src/input.rs",
  "packages/rust_macos_pill/src/input.rs",
  "packages/rust_gtk_pill/src/input.rs",
];

describe("native pill body click feedback", () => {
  it.each(PILL_INPUT_FILES)("emits no haptic thock in %s", (file) => {
    const source = readRepoSource(file);
    const arm = extractRustBlock(source, "ClickAction::Pill => {");

    expect(arm).not.toContain("send_haptic");
  });

  it("still guards a body click while the pill is loading on every platform", () => {
    for (const file of PILL_INPUT_FILES) {
      const source = readRepoSource(file);
      const arm = extractRustBlock(source, "ClickAction::Pill => {");

      expect(arm).toContain("can_emit_interaction_feedback");
    }
  });
});
