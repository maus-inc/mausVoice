import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract: the review decision parser never writes the transcript to the log.
 *
 * A `review_decision` line from the pill carries the text the user dictated
 * and then edited. Logs are attached to bug reports and shipped off the
 * machine, so a diagnostic that echoes the offending line would hand out the
 * transcript with it. The parser is allowed to log why it dropped a line, but
 * only from the error and the short action token.
 */
const PILL_PROCESS_FILE = path.resolve(
  __dirname,
  "../../src-tauri/src/pill_process.rs",
);

const extractFunctionBody = (source: string, signature: string): string => {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end, `end of ${signature} not found`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("pill review decision logging", () => {
  it("keeps the transcript out of the log", () => {
    const source = readFileSync(PILL_PROCESS_FILE, "utf8");
    const body = extractFunctionBody(
      source,
      "pub(crate) fn parse_review_decision(",
    );

    const logCalls = body
      .split("\n")
      .filter((line) => line.includes("log::"))
      .map((line) => line.trim());

    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/\{(line|trimmed|text|value)[:}]/);
    }
  });
});
