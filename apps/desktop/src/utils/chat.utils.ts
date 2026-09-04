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

// Drops trailing code units that would leave a lone surrogate in the
// returned string. slice(0, TITLE_MAX_CHARS) can land on either half of
// a surrogate pair, so the cut is adjusted based on which half survived.
const dropTrailingSurrogate = (text: string): string => {
  const last = text.codePointAt(text.length - 1);
  if (last === undefined) return text;
  if (last >= 0xdc00 && last <= 0xdfff) return text.slice(0, -2);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, -1);
  return text;
};

// Ellipsizes text that was truncated by a prior cap, dropping the last
// character so the trailing … fits the cap exactly when the text is at
// the cap, or appending … directly when the text is already under the
// cap.
const ellipsizeCapped = (text: string, cap: number): string =>
  text.length < cap ? `${text}…` : `${text.slice(0, -1)}…`;

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
    .slice(0, TITLE_MAX_CHARS);
  const trimmed = dropTrailingSurrogate(capped).trimEnd();

  if (trimmed.length === collapsed.length) return trimmed;
  return ellipsizeCapped(trimmed, TITLE_MAX_CHARS);
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

/**
 * The title a conversation should carry after a send. The first message
 * names the conversation, and a conversation that still carries the
 * placeholder also adopts a title from its next message, which covers
 * conversations created before auto-titling existed. A message that
 * yields no derived title leaves the current title alone.
 */
export const nextConversationTitle = (
  text: string,
  currentTitle: string,
  isFirstMessage: boolean,
): string => {
  const shouldDerive = isFirstMessage || hasPlaceholderTitle(currentTitle);
  const derived = deriveConversationTitle(text);
  return shouldDerive && derived ? derived : currentTitle;
};
