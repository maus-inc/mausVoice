/**
 * Deterministic spoken formatting commands.
 *
 * Runs after dictionary replacements and before symbol conversions / LLM
 * cleanup so Verbatim still gets "new line" and "scratch that". English-only
 * (same gate as PR #63 hallucination filter) — command phrases are English.
 *
 * Protected collocations ("new line of credit", "Oxford comma") are never
 * rewritten. "scratch that" drops the previous sentence (or the whole take
 * if there is no sentence boundary).
 */

export const isEnglishSpokenCommandLanguage = (
  language: string | undefined,
): boolean => {
  if (language === undefined) {
    return true;
  }
  const normalized = language.toLowerCase().trim();
  return (
    normalized === "en" ||
    normalized === "english" ||
    normalized === "auto" ||
    normalized === "primary" ||
    normalized.startsWith("en-")
  );
};

type InsertCommand = {
  kind: "insert";
  words: string[];
  value: string;
  attachLeft?: boolean;
  blockedFollowers?: string[][];
  blockedPredecessors?: string[][];
};

type ScratchCommand = {
  kind: "scratch";
  words: string[];
};

type SpokenCommand = InsertCommand | ScratchCommand;

const COMMANDS: SpokenCommand[] = [
  { kind: "scratch", words: ["scratch", "that"] },
  { kind: "scratch", words: ["delete", "that"] },
  { kind: "scratch", words: ["undo", "that"] },
  {
    kind: "insert",
    words: ["new", "paragraph"],
    value: "\n\n",
  },
  {
    kind: "insert",
    words: ["next", "paragraph"],
    value: "\n\n",
  },
  {
    kind: "insert",
    words: ["new", "line"],
    value: "\n",
    blockedFollowers: [["of"]],
  },
  {
    kind: "insert",
    words: ["next", "line"],
    value: "\n",
    blockedFollowers: [["of"]],
  },
  {
    kind: "insert",
    words: ["line", "break"],
    value: "\n",
  },
  {
    kind: "insert",
    words: ["newline"],
    value: "\n",
    blockedFollowers: [["of"]],
  },
  {
    kind: "insert",
    words: ["question", "mark"],
    value: "?",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["exclamation", "mark"],
    value: "!",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["exclamation", "point"],
    value: "!",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["full", "stop"],
    value: ".",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["open", "parenthesis"],
    value: "(",
  },
  {
    kind: "insert",
    words: ["close", "parenthesis"],
    value: ")",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["left", "parenthesis"],
    value: "(",
  },
  {
    kind: "insert",
    words: ["right", "parenthesis"],
    value: ")",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["open", "paren"],
    value: "(",
  },
  {
    kind: "insert",
    words: ["close", "paren"],
    value: ")",
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["open", "quote"],
    value: '"',
  },
  {
    kind: "insert",
    words: ["close", "quote"],
    value: '"',
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["open", "quotes"],
    value: '"',
  },
  {
    kind: "insert",
    words: ["close", "quotes"],
    value: '"',
    attachLeft: true,
  },
  {
    kind: "insert",
    words: ["dot", "dot", "dot"],
    value: "...",
  },
  {
    kind: "insert",
    words: ["comma"],
    value: ",",
    attachLeft: true,
    blockedPredecessors: [["oxford"], ["inverted"], ["serial"]],
  },
  {
    kind: "insert",
    words: ["period"],
    value: ".",
    attachLeft: true,
    blockedFollowers: [["of"], ["in"], ["piece"]],
    blockedPredecessors: [["time"], ["trial"], ["grace"]],
  },
  {
    kind: "insert",
    words: ["colon"],
    value: ":",
    attachLeft: true,
    blockedFollowers: [["cancer"]],
  },
  {
    kind: "insert",
    words: ["semicolon"],
    value: ";",
    attachLeft: true,
  },
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
  return actual.every((token, index) => stripEdgePunctuation(token) === expected[index]);
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
  const boundary = Math.max(
    withoutTrailingStop.lastIndexOf("\n"),
    withoutTrailingStop.lastIndexOf(". "),
    withoutTrailingStop.lastIndexOf("! "),
    withoutTrailingStop.lastIndexOf("? "),
    withoutTrailingStop.lastIndexOf("."),
    withoutTrailingStop.lastIndexOf("!"),
    withoutTrailingStop.lastIndexOf("?"),
  );

  if (boundary < 0) {
    parts.length = 0;
    return;
  }

  const keepThrough = boundary + 1;
  const kept = withoutTrailingStop.slice(0, keepThrough).replace(/[ \t]+$/u, "");
  parts.length = 0;
  if (kept) {
    parts.push(kept);
  }
};

export const applySpokenCommands = (
  text: string,
  language?: string,
): string => {
  if (!text.trim()) {
    return text;
  }
  if (!isEnglishSpokenCommandLanguage(language)) {
    return text;
  }

  const tokens = tokenizeWords(text);
  if (tokens.length === 0) {
    return text;
  }

  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const output: string[] = [];
  let index = 0;
  let pendingSpace = false;

  const flushSpace = () => {
    if (pendingSpace && output.length > 0) {
      const last = output[output.length - 1] ?? "";
      if (!last.endsWith("\n") && !last.endsWith("(") && last !== '"') {
        output.push(" ");
      }
    }
    pendingSpace = false;
  };

  while (index < tokens.length) {
    let matched: SpokenCommand | null = null;
    let matchedLength = 0;

    for (const command of COMMANDS_BY_LENGTH) {
      const span = command.words.length;
      if (index + span > tokens.length) {
        continue;
      }
      const slice = tokens.slice(index, index + span);
      if (!wordsMatch(slice, command.words)) {
        continue;
      }
      if (command.kind === "insert") {
        if (
          predecessorBlocked(tokens.slice(0, index), command.blockedPredecessors)
        ) {
          continue;
        }
        if (
          followerBlocked(tokens.slice(index + span), command.blockedFollowers)
        ) {
          continue;
        }
      }
      matched = command;
      matchedLength = span;
      break;
    }

    if (!matched) {
      flushSpace();
      output.push(tokens[index] ?? "");
      pendingSpace = true;
      index += 1;
      continue;
    }

    if (matched.kind === "scratch") {
      applyScratch(output);
      pendingSpace = output.length > 0;
      index += matchedLength;
      continue;
    }

    if (matched.attachLeft) {
      trimTrailingSpace(output);
      output.push(matched.value);
      pendingSpace = true;
    } else if (matched.value.startsWith("\n")) {
      trimTrailingSpace(output);
      output.push(matched.value);
      pendingSpace = false;
    } else if (matched.value === "(" || matched.value === '"') {
      flushSpace();
      output.push(matched.value);
      pendingSpace = false;
    } else {
      flushSpace();
      output.push(matched.value);
      pendingSpace = true;
    }
    index += matchedLength;
  }

  const body = output.join("").replace(/[ \t]+\n/g, "\n").replace(/ +/g, " ");
  return `${leading}${body}${trailing}`;
};
