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

const tokenizeWords = (text: string): string[] => {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
};

const stripEdgePunctuation = (token: string): string =>
  token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").toLowerCase();

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
    const start = previous.length - predecessor.length;
    if (start < 0) {
      return false;
    }
    return wordsMatch(previous.slice(start), predecessor);
  });
};

const trimTrailingSpace = (parts: string[]): void => {
  while (parts.length > 0 && /^\s+$/.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
};

const isAbbreviationStop = (text: string, stopIndex: number): boolean => {
  const before = text.slice(0, stopIndex + 1);
  const word = before.match(/(\S+)$/)?.[1] ?? "";
  if (/^[A-Za-z]\.$/.test(word)) {
    return true;
  }
  return /^(dr|mr|mrs|ms|prof|sr|jr|vs|etc|inc|ltd|st|ave|e\.g|i\.e|u\.s|u\.k)\.$/i.test(
    word,
  );
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

const applyScratch = (parts: string[]): void => {
  trimTrailingSpace(parts);
  const joined = parts.join("");
  if (!joined) {
    parts.length = 0;
    return;
  }

  const withoutTrailingStop = joined
    .replace(/[.!?]+$/u, "")
    .replace(/[ \t]+$/u, "");
  const boundary = lastSentenceBoundary(withoutTrailingStop);

  if (boundary < 0) {
    parts.length = 0;
    return;
  }

  const keepThrough = boundary + 1;
  const kept = withoutTrailingStop
    .slice(0, keepThrough)
    .replace(/[ \t]+$/u, "");
  parts.length = 0;
  if (kept) {
    parts.push(kept);
  }
};

export type ApplySpokenCommandsOptions = {
  skipStructuralCommands?: boolean;
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
    if (command.kind === "scratch") {
      if (skipStructural) {
        continue;
      }
      return { command, length: span };
    }
    if (skipStructural && command.structural) {
      continue;
    }
    if (
      predecessorBlocked(tokens.slice(0, index), command.blockedPredecessors)
    ) {
      continue;
    }
    if (followerBlocked(tokens.slice(index + span), command.blockedFollowers)) {
      continue;
    }
    return { command, length: span };
  }
  return null;
};

const shouldInsertPendingSpace = (output: string[]): boolean => {
  if (output.length === 0) {
    return false;
  }
  const last = output[output.length - 1] ?? "";
  return !last.endsWith("\n") && !last.endsWith("(") && last !== '"';
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

  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
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
  const body = output.join("").replace(/[ \t]+\n/g, "\n");
  return `${leading}${body}${trailing}`;
};
