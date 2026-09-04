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

// True when a code unit is a high surrogate (0xD800-0xDBFF). High
// surrogates always lead a pair, so a trailing high surrogate means
// the low half was dropped by a prior slice.
const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff;

// True when a code unit is a low surrogate (0xDC00-0xDFFF). Low
// surrogates always follow a high surrogate, so a trailing low
// surrogate means the slice kept a complete pair and the next code
// unit is a lone high surrogate from the truncation.
const isLowSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

// Drops trailing code units that would leave a lone surrogate in the
// returned string. slice can land on either half of a surrogate pair,
// so the cut is adjusted based on which half survived.
const dropTrailingSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  if (isHighSurrogate(last)) return text.slice(0, -1);
  if (isLowSurrogate(last)) return text.slice(0, -2);
  return text;
};

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

// Truncates a string so the result never exceeds `cap` code units and
// the cut never lands inside a grapheme cluster. Code-unit cap keeps
// the title length predictable for the sidebar layout; the grapheme
// check keeps emoji and ZWJ sequences intact. Returns the input
// unchanged when it is already at or under the cap.
const capByGraphemes = (text: string, cap: number): string => {
  if (text.length <= cap) return text;
  if (!segmenter) return text.slice(0, cap);

  let cut = cap;
  for (const { segment, index } of segmenter.segment(text)) {
    const end = index + segment.length;
    if (end > cap) break;
    cut = end;
  }
  return text.slice(0, cut);
};

// Ellipsizes text that was truncated by a prior cap. When the text is
// already under the cap, the ellipsis is appended directly. When the
// text is at the cap, the last code unit is dropped so the trailing
// ellipsis keeps the result at or below the cap. Surrogate handling
// runs on the base substring before the ellipsis is added so the
// returned string never contains a dangling surrogate in the middle.
const ellipsizeCapped = (text: string, cap: number): string =>
  `${dropTrailingSurrogate(text.length < cap ? text : text.slice(0, -1))}…`;

// Caps the input at the first `wordCap` whitespace-separated tokens.
const capByWords = (text: string, wordCap: number): string =>
  text.split(" ").slice(0, wordCap).join(" ");

// Caps the input at the first `wordCap` whitespace-separated tokens,
// then at `charCap` code units respecting grapheme boundaries, then
// drops any trailing surrogate and trims trailing whitespace. The
// result is the untruncated capped text.
const capTitleText = (text: string): string =>
  dropTrailingSurrogate(
    capByGraphemes(capByWords(text, TITLE_MAX_WORDS), TITLE_MAX_CHARS),
  ).trimEnd();

/**
 * Derives a very short conversation title from the first user message.
 * Whitespace is collapsed, then the text is capped at a few words and
 * characters and ellipsized when anything was cut.
 */
export const deriveConversationTitle = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return ellipsizeIfTrimmed(capTitleText(collapsed), collapsed);
};

// Returns the trimmed text when nothing was cut, or the ellipsized
// version when the cap shortened it.
const ellipsizeIfTrimmed = (trimmed: string, collapsed: string): string =>
  trimmed.length === collapsed.length
    ? trimmed
    : ellipsizeCapped(trimmed, TITLE_MAX_CHARS);

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
