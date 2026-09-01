import { describe, expect, it } from "vitest";
import { canonicalizeKey, KEY_ALIASES } from "./helper.hooks";

describe("canonicalizeKey / KEY_ALIASES precedence", () => {
  it('maps a raw Space " " to "space"', () => {
    expect(canonicalizeKey(" ")).toBe("space");
    expect(KEY_ALIASES[" "]).toBe("space");
  });

  it("resolves synonyms regardless of case", () => {
    expect(canonicalizeKey("ESC")).toBe("escape");
    expect(canonicalizeKey("esc")).toBe("escape");
    expect(canonicalizeKey("RETURN")).toBe("enter");
    expect(canonicalizeKey("Enter")).toBe("enter");
    expect(canonicalizeKey("Up")).toBe("arrowup");
    expect(canonicalizeKey("Left")).toBe("arrowleft");
  });

  it("prefers the raw key over the trimmed key (precedence)", () => {
    // The raw " " (single space, as KeyboardEvent.key reports Space) resolves
    // through the alias table via the raw branch, not the trimmed branch.
    expect(canonicalizeKey(" ")).toBe(KEY_ALIASES[" "]);
    expect(KEY_ALIASES[" "]).toBe("space");
  });

  it("falls back to the trimmed key when the raw key is not an alias", () => {
    // raw "  space  " is not a key, but the trimmed "space" is.
    expect(canonicalizeKey("  space  ")).toBe("space");
  });

  it("returns the trimmed token for unknown keys", () => {
    expect(canonicalizeKey("  aBc  ")).toBe("abc");
    expect(canonicalizeKey("é")).toBe("é");
  });
});
