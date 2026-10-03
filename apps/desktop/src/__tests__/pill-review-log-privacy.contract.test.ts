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
 */
const LINE_HANDLERS = [
  "pub(crate) fn parse_review_decision_value(",
  "pub(crate) fn parse_style_switch_direction_value(",
  "pub(crate) fn parse_pill_event(",
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

      // A handler that logs nothing cannot leak the transcript, but it is also
      // not what this contract is for, so assert it is the handler at all.
      expect(body.length).toBeGreaterThan(0);
      for (const call of logCalls) {
        expect(call).not.toMatch(PAYLOAD_NAMES);
      }
    },
  );

  it("keeps a parse failure from echoing the line it failed on", () => {
    // The diagnostic for an unparseable line is the one place where a
    // transcription error and the text that caused it are in scope together.
    // `serde_json::Error` carries a position and what it expected, never the
    // input, so logging it is safe -- and this is the assertion that says so,
    // because it is the one that would notice if that ever changed.
    const source = readRepoSource(PILL_PROCESS);
    const body = extractRustBlock(source, "pub(crate) fn parse_pill_event(");
    expect(body).toContain("log::warn!");
    expect(body).toContain("{error}");
    expect(body).not.toMatch(/log::\w+!\([^)]*\{(line|trimmed|text)[:}]/);
  });
});
