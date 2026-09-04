import { describe, expect, it, vi } from "vitest";
import { deriveConversationTitle, hasPlaceholderTitle } from "./chat.utils";

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

  it("caps the title at 32 characters when the first words are long", () => {
    const title = deriveConversationTitle(
      "Supercalifragilisticexpialidocious is a marvelous word indeed",
    );
    expect(title).toBe("Supercalifragilisticexpialidocio…");
    expect(title).toHaveLength(33);
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
