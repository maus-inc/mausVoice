import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  listRepoSources,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: the macOS pill releases the Foundation strings it creates.
 *
 * `NSString::alloc(nil).init_str(...)` hands back a string this process owns,
 * and Cocoa calls that take a string keep their own copy, so the local one has
 * to be released. The pill draws text on every frame, so a string left behind
 * here grows for as long as the app runs. One helper owns that pattern and
 * every caller goes through it.
 */
const MACOS_PILL_SRC = "packages/rust_macos_pill/src";
const HELPER = `${MACOS_PILL_SRC}/nsstring.rs`;

describe("macOS pill Foundation strings", () => {
  it("creates every temporary string through the one helper", () => {
    const offenders = listRepoSources(MACOS_PILL_SRC, ".rs")
      .filter((file) => file !== HELPER)
      .filter((file) => readRepoSource(file).includes("NSString::alloc("));

    expect(offenders).toEqual([]);
  });

  it("releases the string the helper created", () => {
    const helper = extractRustBlock(
      readRepoSource(HELPER),
      "pub(crate) unsafe fn with_ns_string",
    );

    expect(helper).toContain("impl Drop");
    expect(helper).toMatch(/msg_send!\[[^\]]+, release\]/);
  });
});
