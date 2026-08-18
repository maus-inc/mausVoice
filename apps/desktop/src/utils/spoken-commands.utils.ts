import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";

/**
 * Deterministic spoken formatting commands.
 *
 * Pipeline: after replacements and the hallucination strip, before
 * hashtag/pound conversions. English-only via isEnglishSanitizeLanguage —
 * "primary" / "auto" sentinels are not English. Isolated "scratch that"
 * drops the previous sentence. Abbreviations such as "Dr." are not
 * sentence boundaries. Only "scratch that" undoes speech.
 */

export const isEnglishSpokenCommandLanguage = isEnglishSanitizeLanguage;

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
  insert(["new", "line"], "\n", { structural: true, blockedFollowers: [["of"]] }),
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

const tokenizeWords = (text: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  for (const char of text) {
    if (isWhitespaceChar(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
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

const isWhitespaceOnly = (value: string): boolean => {
  if (!value) {
    return false;
  }
  for (const char of value) {
    if (!isWhitespaceChar(char)) {
      return false;
    }
  }
  return true;
};

const trimTrailingSpace = (parts: string[]): void => {
  while (parts.length > 0 && isWhitespaceOnly(parts.at(-1) ?? "")) {
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
  const word = lastNonWhitespaceWord(text.slice(0, stopIndex + 1)).toLowerCase();
  if (word.length === 2 && isAsciiAlnum(word[0] ?? "") && word[1] === ".") {
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

const shouldInsertPendingSpace = (output: string[]): boolean => {
  const last = output.at(-1) ?? "";
  return (
    last.length > 0 &&
    !last.endsWith("\n") &&
    !last.endsWith("(") &&
    last !== '"'
  );
};

const applyInsertCommand = (
  output: string[],
  command: InsertCommand,
  pendingSpace: boolean,
): boolean => {
  if (command.attachLeft) {
    trimTrailingSpace(output);
    output.push(command.value);
    return true;
  }
  if (command.value.startsWith("\n")) {
    trimTrailingSpace(output);
    output.push(command.value);
    return false;
  }
  if (pendingSpace && shouldInsertPendingSpace(output)) {
    output.push(" ");
  }
  output.push(command.value);
  return command.value !== "(" && command.value !== '"';
};

const takeEdgeWhitespace = (text: string, edge: "start" | "end"): string => {
  if (edge === "start") {
    let index = 0;
    while (index < text.length && isWhitespaceChar(text[index] ?? "")) {
      index += 1;
    }
    return text.slice(0, index);
  }
  let index = text.length;
  while (index > 0 && isWhitespaceChar(text[index - 1] ?? "")) {
    index -= 1;
  }
  return text.slice(index);
};

const stripSpacesBeforeNewlines = (text: string): string => {
  let result = "";
  for (const char of text) {
    if (char === "\n") {
      while (result.endsWith(" ") || result.endsWith("\t")) {
        result = result.slice(0, -1);
      }
    }
    result += char;
  }
  return result;
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
  const tokens = tokenizeWords(text);
  if (tokens.length === 0) {
    return text;
  }

  const leading = takeEdgeWhitespace(text, "start");
  const trailing = takeEdgeWhitespace(text, "end");
  const output: string[] = [];
  let index = 0;
  let pendingSpace = false;

  while (index < tokens.length) {
    const matched = matchCommandAt(tokens, index, skipStructural);
    if (!matched) {
      if (pendingSpace && shouldInsertPendingSpace(output)) {
        output.push(" ");
      }
      output.push(tokens[index] ?? "");
      pendingSpace = true;
      index += 1;
      continue;
    }

    if (matched.command.kind === "scratch") {
      applyScratch(output);
      pendingSpace = output.length > 0;
    } else {
      pendingSpace = applyInsertCommand(
        output,
        matched.command,
        pendingSpace,
      );
    }
    index += matched.length;
  }

  // Only strip spaces this function inserted before a newline. Do not collapse
  // user-authored space runs (code, aligned columns, monospaced text).
  const body = stripSpacesBeforeNewlines(output.join(""));
  return `${leading}${body}${trailing}`;
};
