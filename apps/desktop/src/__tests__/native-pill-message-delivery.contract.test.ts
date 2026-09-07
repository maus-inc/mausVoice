import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract: a pill message that never arrives is reported, not swallowed.
 *
 * The pill placement dialog asks the pill where it is and waits for the answer
 * to come back on an event. When the message is dropped on the way out, the
 * answer never arrives and the dialog sits there. Windows and Linux talk to a
 * child process and already report a failed write, so the in-process macOS
 * pill has to report a failed hand off the same way.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const MACOS_OVERLAY = "apps/desktop/src-tauri/src/platform/macos/overlay.rs";
const PILL_PROCESS = "apps/desktop/src-tauri/src/pill_process.rs";

const read = (file: string): string =>
  readFileSync(path.join(REPO_ROOT, file), "utf8");

const extractBlock = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces after ${marker}`);
};

describe("native pill message delivery", () => {
  it("tells the caller when a macOS pill message could not be handed over", () => {
    const overlay = read(MACOS_OVERLAY);

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
      const block = extractBlock(read(MACOS_OVERLAY), `pub fn ${fn}(`);

      expect(block).toContain("=> pill.send(");
      // The old shape sent nothing and answered Ok anyway.
      expect(block).not.toMatch(/pill\.send\([^;]*\);\s*Ok\(\(\)\)/);
    },
  );

  it.each(["notify_request_position", "notify_reset_position"])(
    "keeps the same promise as the child process pill for %s",
    (fn) => {
      const block = extractBlock(read(PILL_PROCESS), `pub fn ${fn}(`);

      expect(block).toContain("Result<(), String>");
    },
  );
});
