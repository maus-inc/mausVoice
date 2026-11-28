import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: the review decision parser never writes the transcript to the log.
 *
 * A `review_decision` line from the pill carries the text the user dictated
 * and then edited. Logs are attached to bug reports and shipped off the
 * machine, so a diagnostic that echoes the offending line would hand out the
 * transcript with it. The parser is allowed to log why it dropped a line, but
 * only from the error and the short action token.
 */
const PILL_PROCESS = "apps/desktop/src-tauri/src/pill_process.rs";

/**
 * Every function in this file that logs while handling a pill line, and so can
 * reach the text on it.
 *
 * The parser that RUNS is `parse_review_decision_value`; the older
 * `parse_review_decision(line)` shim it replaced existed only for its own tests,
 * so a contract pointed at the shim was checking code no runtime path took --
 * while a diagnostic added to the live path went unchecked. Both are named here
 * so neither can be renamed away without this failing, and so the set is the
 * thing a reader has to keep true rather than a single signature.
 *
 * `dispatch_pill_event` is here because it destructures `PillEvent::
 * ReviewDecision { .., text }` and `TypedMessage { text }` and is one `log::error!`
 * away from writing either to the log. It logs `{err}` today, so nothing leaks --
 * the point is that a `{text}` added to that call would now fail this contract,
 * which is the same gap this list exists to close, just one frame further down.
 *
 * `parse_pill_event` logs nothing at all today, and stays anyway. That is not the
 * same as the vacuous assertions removed elsewhere in this change set: this
 * asserts a RULE ("any log call added here must not carry the payload"), which
 * holds vacuously now and takes effect the moment someone adds a `log::` line --
 * whereas `is_char_boundary` on a `&str` could not fail under any input ever.
 * An entry is load-bearing if a future edit would trip it.
 */
const LINE_HANDLERS = [
  "pub(crate) fn parse_review_decision_value(",
  "pub(crate) fn parse_style_switch_direction_value(",
  "pub(crate) fn parse_pill_event(",
  "fn dispatch_pill_event(",
  // The only place a pill line's parse error reaches a log at all. It appears
  // exactly twice in the Rust source -- this definition and the call site above
  // -- so it belongs here rather than in a test of its own: one list to keep
  // true, and a rename cannot drop the diagnostic out of the contract.
  "fn report_unparseable_pill_line(",
];

/** Names whose presence would put the dictated text into a log line. */
const PAYLOAD_NAMES = /\{(line|trimmed|text|value|raw|payload|json)[:}]/;

describe("pill review decision logging", () => {
  it.each(LINE_HANDLERS)(
    "keeps the transcript out of the log: %s",
    (marker) => {
      const source = readRepoSource(PILL_PROCESS);
      const body = extractRustBlock(source, marker);

      const logCalls = body
        .split("\n")
        .filter((line) => line.includes("log::"))
        .map((line) => line.trim());

      // No "is this really the handler?" assertion here, and its absence is
      // deliberate. `extractRustBlock` throws when the marker is not found and
      // slices from `indexOf(marker)`, so a block extracted by a single marker
      // always begins with that marker: `expect(body).toContain(marker)` cannot
      // fail, which is the same vacuity as the `body.length > 0` check it
      // replaced. What has teeth is the per-handler assertion below -- that the
      // handler logs at all, and carries the error rather than the line -- which
      // is why the diagnostic keeps its own test rather than living in this list.
      for (const call of logCalls) {
        expect(call).not.toMatch(PAYLOAD_NAMES);
      }
    },
  );

  it("logs the parse error but never the line that failed to parse", () => {
    // The diagnostic for an unparseable line is the one place where a
    // transcription error and the text that caused it are in scope together.
    // `serde_json::Error` carries a position and what it expected, never the
    // input, so logging it is safe -- and this is the assertion that says so,
    // because it is the one that would notice if that ever changed.
    //
    // The note below is about the old two-marker call, not about this test
    // existing: `extractRustBlock` resolves markers in argument order and keeps
    // the first it finds, and `report_unparseable_pill_line` is defined before
    // `parse_pill_event`, so passing both returned the diagnostic either way. The
    // two `it` blocks that used to sit here therefore read the same string, and
    // the wider negative assertion below is the one worth keeping.
    const source = readRepoSource(PILL_PROCESS);
    const body = extractRustBlock(source, "fn report_unparseable_pill_line(");
    expect(body).toContain("log::warn!");
    expect(body).toContain("{error}");
    expect(body).not.toMatch(/log::\w+!\([^)]*\{(line|trimmed|text|value)[:}]/);
  });
});
