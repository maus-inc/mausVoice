import { describe, expect, it, vi } from "vitest";
import {
  deriveConversationTitle,
  hasPlaceholderTitle,
  nextConversationTitle,
} from "./chat.utils";

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
    const title = deriveConversationTitle(
      "a".repeat(30) + " " + "😀" + " more",
    );
    expect(title).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(title).not.toMatch(/[\uDC00-\uDFFF]$/);
    expect(title.length).toBeLessThanOrEqual(32);
  });

  it("returns an empty string for blank input", () => {
    expect(deriveConversationTitle("   \n\t ")).toBe("");
  });
});

describe("hasPlaceholderTitle", () => {
  it("matches the placeholder in the active locale", () => {
    expect(hasPlaceholderTitle("New conversation")).toBe(true);
  });

  it("matches a placeholder saved under a different locale", () => {
    expect(hasPlaceholderTitle("Neue Unterhaltung")).toBe(true);
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
