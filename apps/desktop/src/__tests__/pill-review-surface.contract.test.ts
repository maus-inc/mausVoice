import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  PILL_CRATES,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: the review surface behaves the same on all three native pills.
 *
 * A transcript under review is answered inside the pill, so three things have
 * to hold on every platform. The panel has to own the window while a review is
 * pending, or its buttons sit outside the clickable area. A button that has
 * scrolled half out of the panel must only answer on the part that shows.
 * And the text the user sends is the text they left in the entry, spacing
 * included, because the transcript is going into their document.
 */
describe("native pill review surface", () => {
  it.each(PILL_CRATES)(
    "clips scrolled click targets to the visible panel on $platform",
    ({ crate }) => {
      const source = readRepoSource(`${crate}/src/draw.rs`);

      expect(source).toContain("rust_pill_shared::clip_span_to_band(");
      // The centre test kept the hidden half of a half-scrolled button
      // clickable and dropped the visible sliver of the next one.
      expect(source).not.toContain("let center = region.y + region.h / 2.0;");
    },
  );

  it.each(PILL_CRATES)(
    "gives the panel the window while a review is pending on $platform",
    ({ crate }) => {
      const state = readRepoSource(`${crate}/src/state.rs`);
      const ownsPanel = extractRustBlock(
        state,
        "pub(crate) fn owns_panel(&self)",
      );
      expect(ownsPanel).toContain("assistant_review");

      const mode = extractRustBlock(
        state,
        "pub(crate) fn effective_window_mode(&self)",
      );
      expect(mode).toContain("WindowMode::AssistantTyping");

      // Hit testing must never gate the panel on the assistant alone: a review
      // opens the panel with no assistant session running.
      const input = readRepoSource(`${crate}/src/input.rs`);
      expect(input).not.toContain(
        "state.assistant_active.get() || state.panel_open_t.get()",
      );
    },
  );

  it("shapes the clickable Linux window around panel ownership", () => {
    const input = readRepoSource("packages/rust_gtk_pill/src/input.rs");
    const region = extractRustBlock(
      input,
      "pub(crate) fn set_expanded_input_region(",
    );

    expect(region).toContain("state.owns_panel()");
  });

  it.each(PILL_CRATES)(
    "sends the entry text as typed on $platform",
    ({ crate }) => {
      const input = readRepoSource(`${crate}/src/input.rs`);
      const submit = extractRustBlock(input, "pub(crate) fn submit_entry(");

      expect(submit).toContain("state.entry_text.borrow().clone()");
      // Trimming is only allowed to answer "is there anything to send".
      expect(submit).not.toContain("borrow().trim().to_string()");
      expect(submit).toContain("text.trim().is_empty()");
    },
  );

  it("keeps the Windows entry text when nothing was sent", () => {
    const pill = readRepoSource("packages/rust_windows_pill/src/pill.rs");
    const handler = extractRustBlock(pill, "fn handle_edit_message(msg: &MSG)");

    // Clearing the control has to follow a decision actually leaving the pill,
    // otherwise a blank-looking entry erases the transcript for nothing.
    expect(handler).toMatch(
      /if sent \{\s*unsafe \{\s*let _ = SetWindowTextW\(edit, w!\(""\)\);/,
    );
  });
});
