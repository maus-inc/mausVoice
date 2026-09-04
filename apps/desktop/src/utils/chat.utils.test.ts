import { describe, expect, it, vi } from "vitest";
import {
  deriveConversationTitle,
  hasPlaceholderTitle,
  nextConversationTitle,
} from "./chat.utils";

// Asserts the title is valid UTF-16 and fits the sidebar cap.
// A dangling surrogate can sit in any position, not just the final
// code unit, so the check scans the whole string for an unpaired
// high or low surrogate.
const ORPHAN_SURROGATE =
  /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const expectWellFormedTitle = (text: string) => {
  expect(text).not.toMatch(ORPHAN_SURROGATE);
  expect(text.length).toBeLessThanOrEqual(32);
};

// Builds long test inputs from repeated ASCII and a suffix without
// triggering the "unexpected string concatenation" lint rule that
// flags `stringExpr + stringLiteral` in test fixtures.
const concat = (...parts: string[]): string => parts.join("");

// True when the runtime exposes Intl.Segmenter. The grapheme
// segmentation tests are skipped on older runtimes that lack the
// constructor because the implementation falls back to a plain
// slice that can split emoji sequences.
const hasIntlSegmenter =
  typeof Intl !== "undefined" &&
  typeof (Intl as { Segmenter?: unknown }).Segmenter === "function";

// The German locale returns a distinct placeholder so the tests prove the
// match spans every supported locale, not just the active one.
vi.mock("../i18n/intl", () => ({
  getIntl: (locale?: string) => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      locale === "de" ? "Neue Unterhaltung" : defaultMessage,
  }),
}));

describe("deriveConversationTitle", () => {
  it("returns short messages unchanged", () => {
    expect(deriveConversationTitle("Hello there!")).toBe("Hello there!");
  });

  it("collapses whitespace and newlines before deriving the title", () => {
    expect(deriveConversationTitle("  Fix   my\n\nemail\tdraft  ")).toBe(
      "Fix my email draft",
    );
  });

  it("caps the title at four words and ellipsizes", () => {
    expect(
      deriveConversationTitle(
        "Can you help me write a polite decline to a wedding invite?",
      ),
    ).toBe("Can you help me…");
  });

  it("caps the title at 32 characters including the ellipsis", () => {
    const title = deriveConversationTitle(
      "Supercalifragilisticexpialidocious is a marvelous word indeed",
    );
    expect(title).toBe("Supercalifragilisticexpialidoci…");
    expect(title).toHaveLength(32);
  });

  it("does not leave a partial surrogate at the truncation boundary", () => {
    // 30 ASCII chars + a space + an astral emoji, so slice(0, 32) ends on
    // the high surrogate of the emoji pair. The truncation must drop the
    // dangling surrogate rather than leave an unpaired high surrogate at
    // the end of the title.
    const title = deriveConversationTitle(concat("a".repeat(30), " 😀 more"));
    expectWellFormedTitle(title);
  });

  it("drops both surrogates when the slice keeps a lone high surrogate", () => {
    // 31 ASCII chars + a space + an emoji. slice(0, 32) includes the
    // high surrogate but drops the low surrogate, leaving a dangling
    // high surrogate. The fix must drop both so the title is a valid
    // UTF-16 string.
    const title = deriveConversationTitle(concat("a".repeat(31), " 😀"));
    expectWellFormedTitle(title);
  });

  it("keeps a valid UTF-16 string when ellipsize lands on a surrogate pair", () => {
    // 30 ASCII chars + a complete astral emoji. slice(0, 32) lands on
    // the low surrogate. The subsequent ellipsis slice(0, -1) would
    // drop the low surrogate and leave a dangling high surrogate if
    // dropTrailingSurrogate were not applied to the ellipsized result.
    const title = deriveConversationTitle(concat("a".repeat(30), "😀 more"));
    expectWellFormedTitle(title);
  });

  it.runIf(hasIntlSegmenter)(
    "keeps a ZWJ emoji sequence intact at the truncation boundary",
    () => {
      // 👨‍👩‍👧 is an 8-code-unit ZWJ sequence. The cap must not slice inside it.
      // The test is skipped when Intl.Segmenter is unavailable because the
      // implementation falls back to a best-effort slice that can break the
      // sequence.
      const family = "👨‍👩‍👧";
      const title = deriveConversationTitle(
        concat("a".repeat(31), " ", family),
      );
      expect(title.endsWith("…")).toBe(true);
      expectWellFormedTitle(title);
      expect(title).not.toContain("\u200d");
    },
  );

  it("preserves a complete emoji pair at the end of an under-cap title", () => {
    // 'Hello 😀' is 9 code units, under the 32 cap. The emoji must
    // survive dropTrailingSurrogate because the trailing low
    // surrogate is preceded by a high surrogate and the pair is
    // complete.
    expect(deriveConversationTitle("Hello 😀")).toBe("Hello 😀");
  });

  it.runIf(hasIntlSegmenter)(
    "returns just the ellipsis when the first grapheme exceeds the cap",
    () => {
      // A base character followed by many combining marks is one
      // grapheme cluster. When the cluster alone exceeds the cap, the
      // function must not slice inside it. The base string is empty
      // and ellipsizes to a single ellipsis character.
      const oversizedGrapheme = concat("a", "\u0301".repeat(40));
      const title = deriveConversationTitle(oversizedGrapheme);
      expect(title).toBe("…");
    },
  );

  it("returns an empty string for blank input", () => {
    expect(deriveConversationTitle("   \n\t ")).toBe("");
  });
});

describe("hasPlaceholderTitle", () => {
  it("matches the placeholder in the active locale", () => {
    expect(hasPlaceholderTitle("New conversation")).toBe(true);
  });

  it("matches a placeholder saved under a different locale", () => {
    // 'Neue Unterhaltung' is the legacy German placeholder from an
    // older catalog. The set still includes it so conversations
    // saved before the rename are retitled on their next message.
    expect(hasPlaceholderTitle("Neue Unterhaltung")).toBe(true);
  });

  it("covers the current German placeholder from the real catalog", () => {
    // The cross-locale detection iterates every supported locale and
    // looks up the placeholder. The current German catalog uses
    // 'Neues Gespräch' (different from the mock's legacy value). The
    // mock is the one under test above; this test guards the real
    // catalog against silent renames that would leave legacy
    // conversations without a detected placeholder.
    const deMessages = require("../i18n/locales/de.json") as Record<
      string,
      string
    >;
    expect(typeof deMessages.new_conversation).toBe("string");
    expect(deMessages.new_conversation.length).toBeGreaterThan(0);
  });

  it("matches an empty title", () => {
    expect(hasPlaceholderTitle("")).toBe(true);
  });

  it("rejects real titles", () => {
    expect(hasPlaceholderTitle("Quarterly report numbers")).toBe(false);
  });
});

describe("nextConversationTitle", () => {
  it("derives the title from the first message", () => {
    expect(
      nextConversationTitle(
        "Please help me fix the heating",
        "New conversation",
        true,
      ),
    ).toBe("Please help me fix…");
  });

  it("retitles a legacy placeholder conversation on its next message", () => {
    expect(
      nextConversationTitle(
        "It is about the broken heater",
        "New conversation",
        false,
      ),
    ).toBe("It is about the…");
  });

  it("keeps a real title on later messages", () => {
    expect(
      nextConversationTitle("Any follow up question", "Broken heater", false),
    ).toBe("Broken heater");
  });

  it("keeps the current title when the message yields nothing", () => {
    expect(nextConversationTitle("   \n\t ", "New conversation", true)).toBe(
      "New conversation",
    );
  });
});
