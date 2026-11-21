import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: a pill message that never arrives is reported, not swallowed.
 *
 * The pill placement dialog asks the pill where it is and waits for the answer
 * to come back on an event. When the message is dropped on the way out, the
 * answer never arrives and the dialog sits there. Windows and Linux talk to a
 * child process and already report a failed write, so the in-process macOS
 * pill has to report a failed hand off the same way.
 */
const MACOS_OVERLAY = "apps/desktop/src-tauri/src/platform/macos/overlay.rs";
const PILL_PROCESS = "apps/desktop/src-tauri/src/pill_process.rs";

describe("native pill message delivery", () => {
  it("tells the caller when a macOS pill message could not be handed over", () => {
    const overlay = readRepoSource(MACOS_OVERLAY);

    expect(overlay).toContain(
      "fn send(&self, msg: InMessage) -> Result<(), String>",
    );
    // A locked or closed channel used to end here, with the caller told the
    // message was on its way.
    expect(overlay).not.toContain("let _ = sender.send(msg);");
  });

  it.each(["notify_request_position", "notify_reset_position"])(
    "passes a failed %s back to the command on macOS",
    (fn) => {
      const block = extractRustBlock(
        readRepoSource(MACOS_OVERLAY),
        `pub async fn ${fn}(`,
        `pub fn ${fn}(`,
      );

      expect(block).toMatch(/pill\s*\.\s*send\(/);
      // The old shape sent nothing and answered Ok anyway. Every whitespace
      // position is allowed, because `let _ = pill` on one line and `.send(..)`
      // on the next discards the result just as silently as `pill.send(..)`.
      expect(block).not.toMatch(/pill\s*\.\s*send\([^;]*\)\s*;\s*Ok\(\(\)\)/);
      // Discarding the result is the same defect with a different spelling, and
      // the newline is the spelling that slipped through: the positive pattern
      // above accepts the whitespace, so the negative one has to accept it too.
      // Without the `\s*` a `let _ = pill` newline `.send(..)` passed this test
      // while the caller waited for a response that a closed channel never sent.
      expect(block).not.toMatch(/let\s+_\s*=\s*pill\s*\.\s*send\(/);
    },
  );

  it.each(["notify_request_position", "notify_reset_position"])(
    "keeps the same promise as the child process pill for %s",
    (fn) => {
      const block = extractRustBlock(
        readRepoSource(PILL_PROCESS),
        `pub async fn ${fn}(`,
        `pub fn ${fn}(`,
      );

      expect(block).toContain("Result<(), String>");
    },
  );
});
