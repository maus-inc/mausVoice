import { spawnSync } from "node:child_process";

// A rule under review can be an arbitrarily expensive JavaScript regexp. The
// real scanner uses RE2, but these offline fixtures use JS semantics; isolate
// that work so backtracking cannot hang the CI guard's own event loop. The
// pattern and fixtures travel via stdin, never as code or shell arguments.
const CHILD_SOURCE = `
  const fs = require("node:fs");
  try {
    const { pattern, fixtures } = JSON.parse(fs.readFileSync(0, "utf8"));
    const regex = new RegExp(pattern);
    process.stdout.write(JSON.stringify({ matches: fixtures.map((value) => regex.test(value)) }));
  } catch {
    process.stdout.write(JSON.stringify({ invalid: true }));
  }
`;

const MAX_PATTERN_LENGTH = 64 * 1024;
const REGEX_TIMEOUT_MS = 2_000;

/** Treat a timeout or a failed child as a failed guard, never as a match. */
function assertChildSucceeded(child) {
  if (child.error) throwChildError(child.error);
  if (child.status !== 0) {
    throw new Error("rule regex fixture test could not complete");
  }
}

function throwChildError(error) {
  if (error.code === "ETIMEDOUT") {
    throw new Error("rule regex fixture test timed out");
  }
  throw new Error("rule regex fixture test could not complete");
}

function parseChildOutput(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("rule regex fixture test returned an invalid result");
  }
  if (!result || typeof result !== "object") {
    throw new Error("rule regex fixture test returned an invalid result");
  }
  return result;
}

/** Reject incomplete or malformed child output rather than trusting it. */
function decodeMatches(stdout, count) {
  const result = parseChildOutput(stdout);
  if (result.invalid) throw new Error("rule regex is not valid");
  if (!validMatches(result.matches, count)) {
    throw new Error("rule regex fixture test returned an invalid result");
  }
  return result.matches;
}

function validMatches(matches, count) {
  return (
    Array.isArray(matches) &&
    matches.length === count &&
    matches.every((match) => typeof match === "boolean")
  );
}

/** Test one rule against all fixtures in a child with a hard deadline. */
export function testBoundedRegex(pattern, fixtures) {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error("rule regex exceeds the maximum length");
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--eval", CHILD_SOURCE], {
    input: JSON.stringify({ pattern, fixtures }),
    encoding: "utf8",
    timeout: REGEX_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env,
  });
  assertChildSucceeded(child);
  return decodeMatches(child.stdout, fixtures.length);
}
