import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";

/**
 * Deterministic spoken formatting commands.
 *
 * Pipeline: after replacements and the hallucination strip, before
 * hashtag/pound conversions. Explicit non-English languages are left alone.
 * Auto-detect applies the English command grammar because commands only match
 * exact English word sequences; otherwise the default-on feature would become
 * a silent no-op for the first-class `auto` setting. Isolated "scratch that"
 * drops the previous sentence. Abbreviations such as "Dr." are not sentence
 * boundaries. Only "scratch that" undoes speech.
 */

export const isEnglishSpokenCommandLanguage = (
  language: string | undefined,
): boolean =>
  language?.trim().toLowerCase() === "auto" ||
  isEnglishSanitizeLanguage(language);

type InsertCommand = {
  kind: "insert";
  words: string[];
  value: string;
  attachLeft?: boolean;
  structural?: boolean;
  blockedFollowers?: string[][];
  blockedPredecessors?: string[][];
};

type ScratchCommand = {
  kind: "scratch";
  words: string[];
};

type SpokenCommand = InsertCommand | ScratchCommand;

const insert = (
  words: string[],
  value: string,
  extras?: Omit<InsertCommand, "kind" | "words" | "value">,
): InsertCommand => ({ kind: "insert", words, value, ...extras });

const COMMANDS: SpokenCommand[] = [
  { kind: "scratch", words: ["scratch", "that"] },
  insert(["new", "paragraph"], "\n\n", { structural: true }),
  insert(["next", "paragraph"], "\n\n", { structural: true }),
  insert(["new", "line"], "\n", {
    structural: true,
    blockedFollowers: [["of"]],
  }),
  insert(["next", "line"], "\n", {
    structural: true,
    blockedFollowers: [["of"]],
  }),
  insert(["line", "break"], "\n", { structural: true }),
  insert(["newline"], "\n", { structural: true, blockedFollowers: [["of"]] }),
  insert(["question", "mark"], "?", { attachLeft: true }),
  insert(["exclamation", "mark"], "!", { attachLeft: true }),
  insert(["exclamation", "point"], "!", { attachLeft: true }),
  insert(["full", "stop"], ".", { attachLeft: true }),
  insert(["open", "parenthesis"], "("),
  insert(["close", "parenthesis"], ")", { attachLeft: true }),
  insert(["left", "parenthesis"], "("),
  insert(["right", "parenthesis"], ")", { attachLeft: true }),
  insert(["open", "paren"], "("),
  insert(["close", "paren"], ")", { attachLeft: true }),
  insert(["open", "quote"], '"'),
  insert(["close", "quote"], '"', { attachLeft: true }),
  insert(["open", "quotes"], '"'),
  insert(["close", "quotes"], '"', { attachLeft: true }),
  insert(["dot", "dot", "dot"], "..."),
  insert(["comma"], ",", {
    attachLeft: true,
    blockedPredecessors: [["oxford"], ["inverted"], ["serial"]],
  }),
  insert(["period"], ".", {
    attachLeft: true,
    blockedFollowers: [["of"], ["in"], ["piece"]],
    blockedPredecessors: [["time"], ["trial"], ["grace"]],
  }),
  insert(["colon"], ":", { attachLeft: true, blockedFollowers: [["cancer"]] }),
  insert(["semicolon"], ";", { attachLeft: true }),
];

const COMMANDS_BY_LENGTH = [...COMMANDS].sort(
  (left, right) => right.words.length - left.words.length,
);

// ASCII-only by design: the spoken-command pipeline is English-gated
// (isEnglishSanitizeLanguage), so command tokens are always ASCII and any
// non-ASCII neighbour (accented letters, full-width punctuation outside the
// covered 。！？ set) is treated as an edge to strip during matching. If the
// pipeline ever goes multilingual, normalize Unicode alphanumerics here
// instead of widening this predicate.
const isAsciiAlnum = (char: string): boolean =>
  (char >= "0" && char <= "9") ||
  (char >= "A" && char <= "Z") ||
  (char >= "a" && char <= "z");

const isHorizontalSpace = (char: string): boolean =>
  char === " " || char === "\t";

const isWhitespaceChar = (char: string): boolean =>
  isHorizontalSpace(char) || char === "\n" || char === "\r";

const isSentenceStop = (char: string): boolean =>
  char === "." || char === "!" || char === "?";

type ParsedSpeech = {
  leading: string;
  words: string[];
  /** `gaps[i]` is the original whitespace between `words[i]` and `words[i + 1]`. */
  gaps: string[];
  trailing: string;
};

const parsePreservingWhitespace = (text: string): ParsedSpeech => {
  const words: string[] = [];
  const gaps: string[] = [];
  let leading = "";
  let trailing = "";
  let currentWord = "";
  let currentGap = "";
  let seenWord = false;

  const flushWord = () => {
    if (!currentWord) {
      return;
    }
    if (seenWord) {
      gaps.push(currentGap);
    } else {
      leading = currentGap;
    }
    words.push(currentWord);
    currentWord = "";
    currentGap = "";
    seenWord = true;
  };

  for (const char of text) {
    if (isWhitespaceChar(char)) {
      if (currentWord) {
        flushWord();
      }
      currentGap += char;
    } else {
      currentWord += char;
    }
  }
  if (currentWord) {
    flushWord();
  }
  trailing = currentGap;

  return { leading, words, gaps, trailing };
};

const stripEdgePunctuation = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && !isAsciiAlnum(token[start] ?? "")) {
    start += 1;
  }
  while (end > start && !isAsciiAlnum(token[end - 1] ?? "")) {
    end -= 1;
  }
  return token.slice(start, end).toLowerCase();
};

const wordsMatch = (actual: string[], expected: string[]): boolean => {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every(
    (token, index) => stripEdgePunctuation(token) === expected[index],
  );
};

const followerBlocked = (
  remaining: string[],
  blockedFollowers: string[][] | undefined,
): boolean => {
  if (!blockedFollowers || remaining.length === 0) {
    return false;
  }
  return blockedFollowers.some((follower) =>
    wordsMatch(remaining.slice(0, follower.length), follower),
  );
};

const predecessorBlocked = (
  previous: string[],
  blockedPredecessors: string[][] | undefined,
): boolean => {
  if (!blockedPredecessors || previous.length === 0) {
    return false;
  }
  return blockedPredecessors.some((predecessor) => {
    if (predecessor.length > previous.length) {
      return false;
    }
    return wordsMatch(previous.slice(-predecessor.length), predecessor);
  });
};

const isHorizontalWhitespaceOnly = (value: string): boolean => {
  if (!value) {
    return false;
  }
  for (const char of value) {
    if (!isHorizontalSpace(char)) {
      return false;
    }
  }
  return true;
};

const trimTrailingSpace = (parts: string[]): void => {
  while (parts.length > 0 && isHorizontalWhitespaceOnly(parts.at(-1) ?? "")) {
    parts.pop();
  }
};

const lastNonWhitespaceWord = (text: string): string => {
  let end = text.length;
  while (end > 0 && isWhitespaceChar(text[end - 1] ?? "")) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && !isWhitespaceChar(text[start - 1] ?? "")) {
    start -= 1;
  }
  return text.slice(start, end);
};

const ABBREVIATION_STOPS = new Set([
  "dr.",
  "mr.",
  "mrs.",
  "ms.",
  "prof.",
  "sr.",
  "jr.",
  "vs.",
  "etc.",
  "inc.",
  "ltd.",
  "st.",
  "ave.",
  "e.g.",
  "i.e.",
  "u.s.",
  "u.k.",
]);

const isAbbreviationStop = (text: string, stopIndex: number): boolean => {
  const word = lastNonWhitespaceWord(
    text.slice(0, stopIndex + 1),
  ).toLowerCase();
  if (
    word.length === 2 &&
    word[0] >= "a" &&
    word[0] <= "z" &&
    word[1] === "."
  ) {
    return true;
  }
  return ABBREVIATION_STOPS.has(word);
};

const lastSentenceBoundary = (text: string): number => {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "\n") {
      return index;
    }
    if (char === "." || char === "!" || char === "?") {
      if (char === "." && isAbbreviationStop(text, index)) {
        continue;
      }
      return index;
    }
  }
  return -1;
};

const trimHorizontalSpaceEnd = (text: string): string => {
  let end = text.length;
  while (end > 0 && isHorizontalSpace(text[end - 1] ?? "")) {
    end -= 1;
  }
  return text.slice(0, end);
};

const trimTrailingStops = (text: string): string => {
  let end = text.length;
  while (end > 0 && isSentenceStop(text[end - 1] ?? "")) {
    end -= 1;
  }
  return text.slice(0, end);
};

const applyScratch = (parts: string[]): void => {
  trimTrailingSpace(parts);
  const joined = parts.join("");
  if (!joined) {
    parts.length = 0;
    return;
  }

  const withoutTrailingStop = trimHorizontalSpaceEnd(trimTrailingStops(joined));
  const boundary = lastSentenceBoundary(withoutTrailingStop);

  if (boundary < 0) {
    parts.length = 0;
    return;
  }

  const kept = trimHorizontalSpaceEnd(
    withoutTrailingStop.slice(0, boundary + 1),
  );
  parts.length = 0;
  if (kept) {
    parts.push(kept);
  }
};

export type ApplySpokenCommandsOptions = {
  skipStructuralCommands?: boolean;
};

const commandApplies = (
  command: SpokenCommand,
  tokens: string[],
  index: number,
  span: number,
  skipStructural: boolean,
): boolean => {
  if (command.kind === "scratch") {
    return !skipStructural;
  }
  if (skipStructural && command.structural) {
    return false;
  }
  if (predecessorBlocked(tokens.slice(0, index), command.blockedPredecessors)) {
    return false;
  }
  return !followerBlocked(tokens.slice(index + span), command.blockedFollowers);
};

const matchCommandAt = (
  tokens: string[],
  index: number,
  skipStructural: boolean,
): { command: SpokenCommand; length: number } | null => {
  for (const command of COMMANDS_BY_LENGTH) {
    const span = command.words.length;
    if (index + span > tokens.length) {
      continue;
    }
    if (!wordsMatch(tokens.slice(index, index + span), command.words)) {
      continue;
    }
    if (!commandApplies(command, tokens, index, span, skipStructural)) {
      continue;
    }
    return { command, length: span };
  }
  return null;
};

const applyTightInsert = (output: string[], value: string): void => {
  trimTrailingSpace(output);
  output.push(value);
};

const containsSpokenCommand = (
  words: string[],
  skipStructural: boolean,
): boolean => {
  for (let probe = 0; probe < words.length; probe += 1) {
    if (matchCommandAt(words, probe, skipStructural)) {
      return true;
    }
  }
  return false;
};

const shouldDropFollowingGap = (command: SpokenCommand): boolean => {
  if (command.kind === "scratch") {
    return true;
  }
  if (command.value.startsWith("\n") || command.value === "(") {
    return true;
  }
  return command.value === '"' && !command.attachLeft;
};

const applyMatchedCommand = (
  output: string[],
  command: SpokenCommand,
  emitOriginalGap: () => void,
): void => {
  if (command.kind === "scratch") {
    applyScratch(output);
    return;
  }
  if (command.attachLeft || command.value.startsWith("\n")) {
    applyTightInsert(output, command.value);
    return;
  }
  emitOriginalGap();
  output.push(command.value);
};

export const applySpokenCommands = (
  text: string,
  language?: string,
  options?: ApplySpokenCommandsOptions,
): string => {
  if (!text.trim() || !isEnglishSpokenCommandLanguage(language)) {
    return text;
  }

  const skipStructural = options?.skipStructuralCommands === true;
  const parsed = parsePreservingWhitespace(text);
  if (
    parsed.words.length === 0 ||
    !containsSpokenCommand(parsed.words, skipStructural)
  ) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  let pendingOriginalGap: string | null = null;

  const emitOriginalGap = () => {
    if (pendingOriginalGap) {
      output.push(pendingOriginalGap);
    }
    pendingOriginalGap = null;
  };

  while (index < parsed.words.length) {
    const matched = matchCommandAt(parsed.words, index, skipStructural);
    if (!matched) {
      emitOriginalGap();
      output.push(parsed.words[index] ?? "");
      pendingOriginalGap = parsed.gaps[index] ?? null;
      index += 1;
      continue;
    }

    applyMatchedCommand(output, matched.command, emitOriginalGap);
    pendingOriginalGap = shouldDropFollowingGap(matched.command)
      ? null
      : (parsed.gaps[index + matched.length - 1] ?? null);
    index += matched.length;
  }

  emitOriginalGap();
  return `${parsed.leading}${output.join("")}${parsed.trailing}`;
};
