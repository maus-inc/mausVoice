// The bindings generator has its own command list.
//
// `examples/gen_bindings.rs` calls `collect_commands![...]` with a hand-written
// list of command names, separate from the `tauri::generate_handler![...]` list
// in `app.rs` that actually registers them. A command added to one and not the
// other is invisible:
//
//   * in `app.rs` only -- it works at runtime and has no TypeScript binding, so
//     the frontend cannot call it;
//   * in `gen_bindings.rs` only -- it does not compile;
//   * in neither, with a `bindings.ts` entry written by hand -- the generated
//     file and the committed one disagree, which is what
//     `check-bindings.sh` catches, but only after a full Rust build on CI.
//
// That last case is exactly what happened: `set_microphone_preroll` was added to
// `app.rs` and to `bindings.ts`, and not to this list. Every local gate passed,
// and the branch was pushed broken. This test closes that gap without a compiler.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_RS = join(REPO_ROOT, "apps", "desktop", "src-tauri", "src", "app.rs");
const GEN_BINDINGS_RS = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "examples",
  "gen_bindings.rs",
);

/**
 * The command names inside a `macro![...]` invocation, normalised to the bare
 * name.
 *
 * `app.rs` writes `crate::commands::name,` because it is outside the module;
 * `gen_bindings.rs` writes `name,` because it glob-imports `commands::*`. Both
 * reduce to the same identifier, which is what the two lists have to agree on.
 */
const namesIn = (source, macroName) => {
  const start = source.indexOf(`${macroName}![`);
  assert.notEqual(start, -1, `${macroName}! not found`);
  // Balance brackets rather than matching to the first `]`: the lists are long
  // and a `]` inside a nested call would end a naive scan early.
  const open = source.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `unterminated ${macroName}![`);
  return source
    .slice(open + 1, end)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split("::").pop());
};

const registered = () =>
  namesIn(readFileSync(APP_RS, "utf8"), "tauri::generate_handler");
const collected = () =>
  namesIn(readFileSync(GEN_BINDINGS_RS, "utf8"), "collect_commands");

/**
 * Commands that are registered but deliberately not collected.
 *
 * Both take or return `tauri::ipc::Request` / `tauri::ipc::Response`, which
 * carry a raw body and headers rather than a serializable value, so Specta
 * cannot express their signatures and the frontend calls them through
 * `invoke` directly. Listing them here rather than filtering by "not in
 * bindings.ts" keeps the exception visible: a third name appearing in this
 * array is a decision someone has to make on purpose.
 */
const UNBOUND_BY_DESIGN = new Set([
  "stop_recording",
  "store_transcription_audio",
]);

describe("the bindings generator agrees with the command registry", () => {
  it("parses a non-trivial number of commands from both lists", () => {
    // A parser that silently returned nothing would make every assertion below
    // pass, which is the failure mode this whole file exists to avoid.
    assert.ok(
      registered().length > 100,
      `only ${registered().length} commands parsed from app.rs`,
    );
    assert.ok(
      collected().length > 100,
      `only ${collected().length} commands parsed from gen_bindings.rs`,
    );
  });

  it("collects every command the app registers, except the ones that cannot be bound", () => {
    const missing = registered().filter(
      (name) => !collected().includes(name) && !UNBOUND_BY_DESIGN.has(name),
    );
    assert.deepEqual(
      missing,
      [],
      `registered in app.rs but absent from gen_bindings.rs, so they get no ` +
        `binding and CI's check-bindings.sh will delete their entries: ${missing.join(", ")}`,
    );
  });

  it("still describes the exclusion list accurately", () => {
    // An entry that is no longer registered is stale documentation, and one that
    // has since been collected does not need the exemption. Either way the list
    // should shrink, so failing here is the prompt to shrink it.
    const registeredNow = registered();
    const collectedNow = collected();
    for (const name of UNBOUND_BY_DESIGN) {
      assert.ok(
        registeredNow.includes(name),
        `${name} is exempted from binding but no longer registered`,
      );
      assert.ok(
        !collectedNow.includes(name),
        `${name} is now collected, so remove it from UNBOUND_BY_DESIGN`,
      );
    }
  });

  it("collects nothing the app does not register", () => {
    // The other direction, which would fail to compile rather than silently
    // drift -- but a name that differs by a character is easier to see here.
    const extra = collected().filter((name) => !registered().includes(name));
    assert.deepEqual(
      extra,
      [],
      `in gen_bindings.rs but not registered: ${extra.join(", ")}`,
    );
  });

  it("names the pre-roll setter in both lists", () => {
    // The specific command whose absence made this test exist. Asserting it by
    // name means a future edit that drops it again fails with the command named,
    // not with a count.
    assert.ok(registered().includes("set_microphone_preroll"));
    assert.ok(collected().includes("set_microphone_preroll"));
  });
});
