// Conservative proof that a GitHub Actions condition cannot run on a fork PR.
// Unknown expressions never prove safety; an AND is safe if either operand is,
// while every OR branch must be safe. Only the reviewed origin comparison and
// push-only event predicate count as safe atoms.
const ORIGIN =
  /^github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository$/;
const PUSH = /^github\.event_name\s*==\s*'push'$/;

/** Return the first position after a quoted literal, or -1 if incomplete. */
function quotedEnd(input, start) {
  const quote = input[start];
  let cursor = start + 1;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === quote) {
      if (input[cursor + 1] !== quote) return cursor + 1;
      cursor += 2;
    } else if (char === "\\" && quote === '"') cursor += 2;
    else cursor++;
  }
  return -1;
}

export function excludesForkPullRequests(condition) {
  let input = condition.trim().replace(/^[|>][+-]?\s*/, "");
  if (input.startsWith("${{") && input.endsWith("}}")) {
    input = input.slice(3, -2).trim();
  }
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(input[cursor] ?? "")) cursor++;
  };
  const readAtom = () => {
    const start = cursor;
    while (cursor < input.length) {
      const char = input[cursor];
      if (char === "'" || char === '"') {
        const end = quotedEnd(input, cursor);
        if (end === -1) return { valid: false, safe: false };
        cursor = end;
        continue;
      }
      if (
        ["(", ")"].includes(char) ||
        ["&&", "||"].includes(input.slice(cursor, cursor + 2))
      )
        break;
      cursor++;
    }
    const atom = input.slice(start, cursor).trim();
    return {
      valid: atom.length > 0,
      safe: ORIGIN.test(atom) || PUSH.test(atom),
    };
  };
  const parsePrimary = () => {
    whitespace();
    if (input[cursor] !== "(") return readAtom();
    cursor++;
    const result = parseOr();
    whitespace();
    if (input[cursor] !== ")") return { valid: false, safe: false };
    cursor++;
    return result;
  };
  const parseAnd = () => {
    let result = parsePrimary();
    whitespace();
    while (input.startsWith("&&", cursor)) {
      cursor += 2;
      const right = parsePrimary();
      result = {
        valid: result.valid && right.valid,
        safe: result.safe || right.safe,
      };
      whitespace();
    }
    return result;
  };
  const parseOr = () => {
    let result = parseAnd();
    whitespace();
    while (input.startsWith("||", cursor)) {
      cursor += 2;
      const right = parseAnd();
      result = {
        valid: result.valid && right.valid,
        safe: result.safe && right.safe,
      };
      whitespace();
    }
    return result;
  };
  const result = parseOr();
  whitespace();
  return result.valid && result.safe && cursor === input.length;
}
