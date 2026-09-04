import { SUPPORTED_LOCALES } from "../i18n/config";
import { getIntl } from "../i18n/intl";

/**
 * Conversation titles live in the narrow chats sidebar. A few words are
 * enough to tell chats apart, so the derived title is deliberately tiny.
 * The cap counts the ellipsis, so a truncated title never runs past 32
 * characters.
 */
const TITLE_MAX_WORDS = 4;
const TITLE_MAX_CHARS = 32;

/**
 * Derives a very short conversation title from the first user message.
 * Whitespace is collapsed, then the text is capped at a few words and
 * characters and ellipsized when anything was cut.
 */
export const deriveConversationTitle = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  const capped = collapsed
    .split(" ")
    .slice(0, TITLE_MAX_WORDS)
    .join(" ")
    .slice(0, TITLE_MAX_CHARS)
    .trimEnd();

  if (capped.length === collapsed.length) return capped;
  const withinCap =
    capped.length < TITLE_MAX_CHARS ? capped : capped.slice(0, -1);
  return `${withinCap}…`;
};

let placeholderTitles: ReadonlySet<string> | undefined;

// Cached once. The set already holds every locale's placeholder, so a
// locale switch never invalidates it. Conversation creation localizes the
// "New conversation" placeholder at creation time, so a row can carry any
// supported locale's translation.
const getPlaceholderTitles = (): ReadonlySet<string> => {
  placeholderTitles ??= new Set(
    SUPPORTED_LOCALES.map((locale) =>
      getIntl(locale).formatMessage({ defaultMessage: "New conversation" }),
    ),
  );
  return placeholderTitles;
};

/**
 * True when a conversation has no title or still carries the localized
 * "New conversation" placeholder, including legacy conversations created
 * before auto-titling or under a different locale. Such conversations adopt
 * a derived title from their next message.
 */
export const hasPlaceholderTitle = (title: string): boolean =>
  !title || getPlaceholderTitles().has(title);
