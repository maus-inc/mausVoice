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
      // The GTK pill factors the decision out so it can be tested against an
      // injected `send`, so the contract is asserted against whichever function
      // holds the logic rather than against a fixed name.
      const submit = extractRustBlock(
        input,
        "fn submit_entry_inner(",
        "pub(crate) fn submit_entry(",
      );

      expect(submit).toContain("entry_text.borrow().clone()");
      // Trimming is only allowed to answer "is there anything to send".
      expect(submit).not.toContain("borrow().trim().to_string()");
      expect(submit).toContain("text.trim().is_empty()");
    },
  );

  it("clears the GTK entry text only when the desktop received it", () => {
    const input = readRepoSource("packages/rust_gtk_pill/src/input.rs");
    const submit = extractRustBlock(input, "fn submit_entry_inner(");

    // A failed write means the pipe is gone, so the one copy of the user's text
    // must survive: clearing it would destroy a transcript nothing can re-send.
    // The decision is reached through `send_review_decision_with` now, so the
    // guard is on the boolean it returns rather than on the send call itself --
    // both a bare insert and a review decision have to clear on success.
    expect(submit).toMatch(
      /if sent \{\s*\*entry_text\.borrow_mut\(\) = String::new\(\);/,
    );
    // And the send has to be captured, not discarded, or the guard above would
    // be testing a value nothing assigned.
    expect(submit).toMatch(/let sent = match review_id \{/);
  });

  it("clears the Windows entry text only when the desktop received it", () => {
    const input = readRepoSource("packages/rust_windows_pill/src/input.rs");
    const submit = extractRustBlock(input, "fn submit_entry_inner(");

    // The Windows pill used to clear the entry unconditionally, so a write that
    // never reached the desktop destroyed the user's only copy of an edited
    // transcript, and the pipe to re-send it on was the pipe that just failed.
    //
    // Two shapes satisfy this, and both have shipped here at different times:
    // guarding the clear with `if sent`, or bailing out early when the send
    // failed and clearing after it. Assert the guard exists and that the clear
    // cannot run before the send, rather than pinning one spelling.
    // Both clearing forms count: `borrow_mut().clear()` and assigning an empty
    // string. The invariant is that the entry is emptied only after a write the
    // desktop received.
    const CLEAR =
      /entry_text\.borrow_mut\(\)\s*(?:\.clear\(\)|=\s*String::new\(\))/;
    const clearIndex = submit.search(CLEAR);
    expect(clearIndex).toBeGreaterThan(-1);

    const guardedBySent = new RegExp(
      `if sent\\s*\\{[\\s\\S]*?${CLEAR.source}`,
    ).test(submit);
    const bailsOutFirst = /if !send\(&msg\)\s*\{\s*return false;/.test(submit);
    expect(
      guardedBySent || bailsOutFirst,
      "the entry clear must be gated on the write having succeeded",
    ).toBe(true);

    // The send has to be resolved before the clear, whichever shape is used.
    const sendIndex = submit.search(/let sent = match review_id/);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeLessThan(clearIndex);
  });

  it("reports whether the Windows write actually reached the desktop", () => {
    const ipc = readRepoSource("packages/rust_windows_pill/src/ipc.rs");
    const send = extractRustBlock(ipc, "pub fn send(");

    // Swallowing every write error is what made the unconditional clear
    // invisible: the caller had no way to know nobody had received the text.
    expect(send).toContain("stdout.flush().is_ok()");
    expect(send).not.toContain("let _ = stdout.flush()");
  });

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
