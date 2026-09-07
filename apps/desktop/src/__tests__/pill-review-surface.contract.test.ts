import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const PLATFORMS = [
  { platform: "windows", crate: "packages/rust_windows_pill" },
  { platform: "macos", crate: "packages/rust_macos_pill" },
  { platform: "gtk", crate: "packages/rust_gtk_pill" },
];

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

describe("native pill review surface", () => {
  it.each(PLATFORMS)(
    "clips scrolled click targets to the visible panel on $platform",
    ({ crate }) => {
      const source = read(`${crate}/src/draw.rs`);

      expect(source).toContain("rust_pill_shared::clip_span_to_band(");
      // The centre test kept the hidden half of a half-scrolled button
      // clickable and dropped the visible sliver of the next one.
      expect(source).not.toContain("let center = region.y + region.h / 2.0;");
    },
  );
});
