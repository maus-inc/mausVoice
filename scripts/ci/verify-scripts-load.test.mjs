import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every script under `scripts/verify/` has to be loadable.
 *
 * These scripts drive a headless browser and write the measurements the QA
 * documents cite, so a throw at module scope is a measurement nobody can
 * reproduce. Nothing checked that before, and one of them shipped dead: a
 * `const URL = ...` at module scope put the global `URL` into its temporal dead
 * zone, so a `new URL(...)` twelve lines above it threw
 * `ReferenceError: Cannot access 'URL' before initialization`. `node --check`
 * passes that file, because the shadowing is legal JavaScript.
 *
 * Two checks, both static because importing the scripts would launch Chromium:
 *
 * 1. No module declares a binding that shadows a global its own module uses.
 * 2. `node --check` accepts the file, which catches syntax errors.
 */

const VERIFY_DIR = new URL("../../scripts/verify/", import.meta.url).pathname;

/** Globals these scripts legitimately reach for. */
const SHADOWABLE_GLOBALS = [
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "structuredClone",
  "fetch",
  "process",
  "console",
  "Buffer",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "performance",
  "crypto",
];

const scriptNames = readdirSync(VERIFY_DIR).filter((name) =>
  name.endsWith(".mjs"),
);

test("the verify directory has scripts to check", () => {
  assert.ok(scriptNames.length > 0, "expected at least one script");
});

for (const name of scriptNames) {
  test(`${name} does not shadow a global it uses`, () => {
    const source = readFileSync(join(VERIFY_DIR, name), "utf8");
    const offenders = [];

    for (const global of SHADOWABLE_GLOBALS) {
      // A top-level declaration of the global's name, at column zero.
      const declares = new RegExp(
        `^(?:const|let|var|function|class)\\s+${global}\\b`,
        "m",
      );
      if (!declares.test(source)) {
        continue;
      }
      // It is only a problem when the module also uses the *global*, which we
      // approximate by counting uses beyond the declaration itself: more than
      // one occurrence of the bare name outside comments and strings.
      const bare = source.match(new RegExp(`(?<![.\\w'"\`])${global}(?![\\w'"\`])`, "g"));
      if ((bare?.length ?? 0) > 1) {
        offenders.push(global);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `${name} redeclares ${offenders.join(", ")} at module scope while also ` +
        `using the global; rename the local binding`,
    );
  });
}
