import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// `here` is <repo>/apps/desktop/src/__tests__, so the desktop app root is two
// levels up and the repo root two more.
const desktopRoot = resolve(here, "..", "..");
const repoRoot = resolve(desktopRoot, "..", "..");

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".git" ||
        entry === "__tests__"
      )
        continue;
      collectFiles(full, acc);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.includes(".test.")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function sourceRoots(): string[] {
  const packageRoots = readdirSync(resolve(repoRoot, "packages"))
    .map((entry) => resolve(repoRoot, "packages", entry, "src"))
    .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory());
  return [resolve(desktopRoot, "src"), ...packageRoots];
}

/**
 * Contract: a timer or listener registration is never handed a callback that is
 * literally `() => undefined`.
 *
 * This exists because of DeepSource rule `JS-0098` ("Expected 'undefined' and
 * instead saw 'void'"), which reports 104 findings across 51 files and keeps
 * reporting them on every scan. Its advice is to write `undefined` where `void`
 * appears. That is harmless where `void` discards a value -- `undefined;`
 * discards nothing and means the same thing -- and it is destructive in an arrow
 * *body*, because there `void` is not producing a value at all:
 *
 *     () => void run()   // calls run()
 *     () => undefined    // never calls run()
 *
 * Both are `undefined`, so no compiler and no assertion distinguishes them. Five
 * such sites are availability-probe retry loops (`setTimeout(() => void run(),
 * 3000)` in the Ollama and OpenAI-compatible model pickers), and applying the
 * rule's advice to them would stop availability polling permanently after a
 * single failure -- silently, with no test to go red.
 *
 * A blanket ban on `() => undefined` would be wrong and is deliberately not what
 * this asserts: `promise.catch(() => undefined)` is a *value* position where
 * `undefined` is exactly right, and this repo has 125 legitimate occurrences. The
 * narrower question -- may a callback that must *do something* be a no-op? -- is
 * the one with a real failure mode.
 *
 * Scope: an optional leading argument is allowed, because the callback is the
 * second parameter of `addEventListener`, and it may also be written after the
 * delay as `setTimeout(3000, () => undefined)`. Both orders are pinned by the
 * anti-vacuity assertions below, which is how the first version of this regex was
 * caught: it matched only the zero-argument-first form, so it would have missed
 * every `addEventListener` in the repo while its own test claimed coverage.
 */
const DEAD_CALLBACK = new RegExp(
  "(setTimeout|setInterval|requestAnimationFrame|addEventListener)\\(" +
    "\\s*(?:(?:\"[^\"]*\"|'[^']*'|[A-Za-z_$][\\w$.]*|[0-9]+)\\s*,\\s*)?" +
    "\\(\\)\\s*=>\\s*undefined\\b",
  "g",
);

/** The retry loops that must keep calling `run` on each attempt. */
const RETRY_PROBE_FILES = [
  "apps/desktop/src/components/settings/OllamaModelPicker.tsx",
  "apps/desktop/src/components/settings/OpenAICompatibleModelPicker.tsx",
];

describe("discarded timer callbacks", () => {
  it("detects a no-op callback and does not flag a legitimate one", () => {
    // Anti-vacuity. A regex that matched nothing would make every assertion
    // below pass for the wrong reason, which is the failure mode this file is
    // most exposed to: it is a source-grep contract with no runtime behaviour.
    expect(
      "setTimeout(() => undefined, 10)".match(DEAD_CALLBACK),
    ).not.toBeNull();
    expect("setInterval(() => undefined)".match(DEAD_CALLBACK)).not.toBeNull();
    expect(
      "setTimeout(3000, () => undefined)".match(DEAD_CALLBACK),
    ).not.toBeNull();
    expect(
      "addEventListener('click', () => undefined)".match(DEAD_CALLBACK),
    ).not.toBeNull();
    // A rejection handler that yields undefined is correct, not dead.
    expect("promise.catch(() => undefined)".match(DEAD_CALLBACK)).toBeNull();
    // And the shape the rule's advice would produce from a real site.
    expect(
      "setTimeout(() => void run(), 3000)".match(DEAD_CALLBACK),
    ).toBeNull();
  });

  it("registers no timer or listener with a callback that does nothing", () => {
    const offenders: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of collectFiles(root)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(DEAD_CALLBACK)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(
            `${file.slice(repoRoot.length + 1)}:${line} ${match[0]}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the availability probes re-arming their retry loop", () => {
    // The floor is load-bearing, not decoration. The first version of this pin had
    // no floor, and emptying the list left all three assertions green: a `for`
    // loop over an empty array runs zero iterations, so "each of these files
    // still re-arms" asserts nothing at all when there are no files. Found by
    // mutation -- the pin passed with nothing pinned.
    expect(RETRY_PROBE_FILES.length).toBeGreaterThanOrEqual(2);
    // Each entry is a user-visible "is this provider reachable" poll that stops
    // after one failed attempt if the callback stops calling `run`.
    for (const relPath of RETRY_PROBE_FILES) {
      const text = readFileSync(resolve(repoRoot, relPath), "utf8");
      expect(
        text.match(/setTimeout\(\(\) => void run\(\),/g)?.length ?? 0,
      ).toBeGreaterThan(0);
    }
  });
});
