import { describe, expect, it } from "vitest";

import { readRepoSource } from "../../test/helpers/rust-source.utils";

/**
 * Contract: Escape answers a transcript under review on every platform.
 *
 * The desktop waits for a decision before it inserts anything, so a review
 * the user cannot dismiss holds up the output path until the five minute
 * expiry. Escape is the documented way out, and it has to work on all three
 * pills, not only the one it was written on first.
 */
const CANCEL_DECISION = 'send_review_decision(&review_id, "cancel", None)';

const ESCAPE_HANDLERS = [
  {
    platform: "windows",
    file: "packages/rust_windows_pill/src/pill.rs",
    // The window procedure and the message loop both read the virtual key.
    key: "VK_ESCAPE",
    cancel: CANCEL_DECISION,
  },
  {
    platform: "macos",
    file: "packages/rust_macos_pill/src/app.rs",
    // The field editor routes Escape to the delegate as `cancelOperation:`.
    key: "sel!(cancelOperation:)",
    cancel: CANCEL_DECISION,
  },
  {
    platform: "gtk",
    file: "packages/rust_gtk_pill/src/pill.rs",
    key: "gdk::keys::constants::Escape",
    cancel: CANCEL_DECISION,
  },
];

describe("Escape cancels a pill review", () => {
  it.each(ESCAPE_HANDLERS)(
    "is wired on the $platform pill",
    ({ file, key, cancel }) => {
      const source = readRepoSource(file);

      expect(source).toContain(key);
      expect(source).toContain(cancel);
    },
  );
});
