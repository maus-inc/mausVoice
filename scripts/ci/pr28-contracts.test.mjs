import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const rawText = new Map();

// Verbatim bytes, memoized per path.
const readRaw = (relativePath) => {
  if (!rawText.has(relativePath)) {
    rawText.set(
      relativePath,
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    );
  }
  return rawText.get(relativePath);
};

// rustfmt is a CI gate across every crate and reflows a long signature across
// lines, so matching the raw text made every guard a formatting change could
// break. Collapsing runs of whitespace keeps each assertion reading as the code
// it means while leaving it indifferent to how rustfmt wraps it.
const collapse = (text) =>
  text
    .replace(/\s+/g, " ")
    // rustfmt breaks a method chain across lines with the `.` leading the next
    // line, which leaves a space before the dot once the newlines are collapsed.
    .replace(/\s+\./g, ".");

// Only the Rust sources are collapsed. rustfmt is what reflows them, while
// prettier leaves the YAML, HTML, MDX and TypeScript files this file also reads
// alone; collapsing those would match text no file holds, since `- .github/**`
// reads as `-.github/**` and a multi-line YAML block becomes one line.
const read = (relativePath) =>
  relativePath.endsWith(".rs")
    ? collapse(readRaw(relativePath))
    : readRaw(relativePath);

// The lines of the item declared at `marker`, up to and including the line that
// closes it, collapsed as `read` collapses a whole file. A guard that inspects
// one function cannot use the collapsed text: a `//` comment runs to the end of
// its line, so collapsing first lets it swallow everything after it, and the
// scope it then computes is the rest of the file rather than the function. The
// first `}` at the item's own indentation is the item's, because rustfmt aligns
// a function's closing brace with its `fn`.
const scopeOf = (relativePath, marker) => {
  const lines = readRaw(relativePath).split("\n");
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) return "";
  const indent = /^ */.exec(lines[start])[0].length;
  const closes = new RegExp(`^ {${indent}}\\}`);
  let end = start + 1;
  while (end < lines.length && !closes.test(lines[end])) end += 1;
  return collapse(lines.slice(start, end + 1).join("\n"));
};

const PATHS = [
  ["commands", "apps/desktop/src-tauri/src/commands.rs"],
  ["tray", "apps/desktop/src-tauri/src/system/tray.rs"],
  ["effects", "apps/desktop/src/components/root/AppSideEffects.tsx"],
  ["macOverlay", "apps/desktop/src-tauri/src/platform/macos/overlay.rs"],
  ["linuxOverlay", "apps/desktop/src-tauri/src/platform/linux/overlay.rs"],
  [
    "windowsOverlay",
    "apps/desktop/src-tauri/src/platform/windows/overlay.rs",
  ],
  ["commonPlatform", "apps/desktop/src-tauri/src/platform/common.rs"],
  ["macPill", "packages/rust_macos_pill/src/app.rs"],
  ["gtkPill", "packages/rust_gtk_pill/src/pill.rs"],
  ["gtkInput", "packages/rust_gtk_pill/src/input.rs"],
  ["gtkX11", "packages/rust_gtk_pill/src/x11.rs"],
  ["windowsPill", "packages/rust_windows_pill/src/pill.rs"],
  ["macApp", "packages/rust_macos_pill/src/app.rs"],
  ["pillProcess", "apps/desktop/src-tauri/src/pill_process.rs"],
  ["macState", "packages/rust_macos_pill/src/state.rs"],
  ["gtkState", "packages/rust_gtk_pill/src/state.rs"],
  ["windowsState", "packages/rust_windows_pill/src/state.rs"],
  ["sharedPill", "packages/rust_pill_shared/src/lib.rs"],
  ["sharedHover", "packages/rust_pill_shared/src/hover.rs"],
  ["sharedDrag", "packages/rust_pill_shared/src/drag.rs"],
  ["sharedSpring", "packages/rust_pill_shared/src/spring.rs"],
  ["macDraw", "packages/rust_macos_pill/src/draw.rs"],
  ["macInput", "packages/rust_macos_pill/src/input.rs"],
  ["gtkDraw", "packages/rust_gtk_pill/src/draw.rs"],
  ["windowsDraw", "packages/rust_windows_pill/src/draw.rs"],
  ["windowsGfx", "packages/rust_windows_pill/src/gfx.rs"],
  ["recording", "apps/desktop/src-tauri/src/domain/recording.rs"],
  ["audioChunks", "apps/desktop/src/sessions/audio-chunk-events.ts"],
  [
    "intake",
    "apps/desktop/src/components/root/dictation-recording-intake.ts",
  ],
  ["integrationWorkflow", ".github/workflows/test-desktop-integration.yml"],
  ["docsWorkflow", ".github/workflows/test-docs.yml"],
  ["index", "index.html"],
  ["astro", "apps/docs/astro.config.mjs"],
  ["docsIndex", "apps/docs/src/content/docs/index.mdx"],
  ["docsLlms", "apps/docs/public/llms.txt"],
  ["docsRobots", "apps/docs/public/robots.txt"],
];

const pathOf = new Map(PATHS);
const source = Object.fromEntries(
  PATHS.map(([name, path]) => [name, read(path)]),
);
// One function's body, for the guards that read code rather than the file.
const scope = (name, marker) => scopeOf(pathOf.get(name), marker);

// The `jobs:` table of a workflow as { name, body } records. A guard that has to
// prove a secret is inside a guarded job cannot scan the file as one string:
// the guard and the secret are the same text wherever they both appear.
const workflowJobs = (workflowText) => {
  // Line endings are normalised here, at the one place the text is split, because every pattern
  // below is anchored per line and `.` does not match `\r`. Left alone, a CRLF checkout fails
  // every key pattern at once, no `if:` is found anywhere, and every job reads as unguarded --
  // a total gate failure on a file GitHub Actions itself accepts. No workflow in the repo is
  // CRLF today, and `.gitattributes` normalises only `*.sql`, so this is latent rather than
  // firing; it is fixed because the failure is silent and total.
  const lines = workflowText.replace(/\r\n?/g, "\n").split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  const jobs = [];
  let name = null;
  let body = [];
  for (const line of lines.slice(jobsAt + 1)) {
    // A trailing comment is allowed on the job key. Without this, `  provider:  # gated` is not
    // recognised as a job at all, so `workflowJobs` returns nothing and the gate fails with
    // "the workflow must declare at least one job" -- which points an author who DID declare a
    // job at the wrong thing. Only the comment is tolerated here; a value after the colon is not
    // a job key and still fails to match.
    const job = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (job) {
      if (name) jobs.push({ name, body: body.join("\n") });
      name = job[1];
      body = [];
      continue;
    }
    if (name) body.push(line);
  }
  if (name) jobs.push({ name, body: body.join("\n") });
  return jobs;
};

// What this gate proves, and what it does not. It is worth being exact, because a security gate
// that is read as stronger than it is has failed in the way that matters.
//
// PROVES: the guard text is the VALUE of an `if:` key, on either the job or the reading step, and
// that the key is not inside a comment. That closes "the guard is mentioned somewhere in this job".
//
// DOES NOT PROVE: that the condition GATES. `if: <guard> || always()` names every path and admits
// every fork, and passes. Settling that means evaluating a GitHub expression, which a text check
// cannot do; this gate deliberately checks for the token and says so rather than approximating.
//
// Also not followed: a guard reached through an `env:` indirection in its own `if:` (`if: env.SAME
// == 'true'`), and one literal spelling of the comparison (`== ` with single spaces, operands in
// this order). Both are legal and both fail closed, which means a correctly gated workflow written
// that way is rejected rather than admitted.
const FORK_GUARD_SOURCE =
  "github.event.pull_request.head.repo.full_name == github.repository";
const FORK_GUARD_RE = new RegExp(
  FORK_GUARD_SOURCE.replace(/\./g, "\\."),
);

/**
 * Where the YAML comment starts on `line`, or -1 when the line has none.
 *
 * Three rules. A `#` only opens a comment after whitespace or at the start of the line, so
 * `run: echo a#b` has no comment. A `#` inside a quoted scalar is data, and a backslash escapes
 * the next character inside a double-quoted one, so `run: echo "a \" # b"` has no comment
 * either. And cutting at the FIRST comment opener is sufficient: text after a comment cannot
 * make a match appear, it can only remove text, so no later `#` needs finding.
 *
 * Every rule here can only REMOVE text, never add it, so a mistake in any of them rejects a
 * correctly guarded job rather than admitting an unguarded one.
 */
const commentStart = (line) => {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return index;
  }
  return -1;
};

/**
 * `text` with every line's trailing comment removed, so prose cannot satisfy a condition match.
 *
 * Whole-line comments are the easy half. A comment AFTER an `if:` value is the half that matters:
 * `if: always()  # github.event.pull_request...` leaves the job unguarded on every fork, and the
 * real workflow documents this rule in a comment directly above its own `if:`, which makes the
 * trailing spelling the natural next one to try.
 */
const stripYamlComments = (text) =>
  text
    .split("\n")
    .map((line) => {
      const at = commentStart(line);
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

/**
 * The value of the `if:` key at exactly `indent` spaces, comments already stripped.
 *
 * Key-anchored on purpose. A guard is a condition only when it is the VALUE of an `if:` key. The
 * same text in a `run:` body, a `name:`, or an `env:` value gates nothing -- matching the guard
 * anywhere in the job text is precisely what let a job with the guard only in prose pass.
 *
 * A block scalar body (`if: |`) continues at deeper indentation than its key, so the body is
 * collected too. `FORK_GUARD_RE` needs the two halves concatenated, because a folded or split
 * condition puts the guard somewhere other than the first physical line.
 */
const ifConditionAt = (text, indent) => {
  const keyPattern = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):(.*)$`);
  // A block scalar body is deeper than its key by at least one column. Deriving that threshold
  // from `indent` rather than fixing it at 6 is what makes the sentence above true of a job-level
  // key at 4 and a step-level key at 6 alike; the two shapes in use are 6 and 10 columns.
  const bodyPattern = new RegExp(`^ {${indent + 1},}\\S`);
  const parts = [];
  let collecting = false;
  for (const line of text.split("\n")) {
    const key = keyPattern.exec(line);
    if (key !== null) {
      // Any other key ends the previous `if:` and only an `if:` starts a new one.
      if (key[1] !== "if") collecting = false;
      else {
        collecting = true;
        parts.push(key[2].trim());
      }
      continue;
    }
    if (collecting && bodyPattern.test(line)) {
      parts.push(line.trim());
      continue;
    }
    if (line.trim() !== "") collecting = false;
  }
  return parts.join(" ");
};

/**
 * A job body split into the job's own keys (`header`) and its steps.
 *
 * Two shapes this has to get right, each of which a fixed-indent heuristic gets wrong:
 *
 *   - The step list ENDS where the job's own keys resume, so a job-level `if:` written AFTER
 *     `steps:` is still a job-level `if:`. YAML mapping order carries no meaning, so reading only
 *     the header above `steps:` rejects a correctly guarded job.
 *   - The step indent comes from the first dash rather than being assumed, because a sequence item
 *     may legally sit at its parent key's own indent (`steps:` at 4 with `- ` at 4). A split that
 *     hardcoded 6 spaces could not see those, and would then attribute the secret to the header,
 *     where only a job-level `if:` can gate it -- so a guarded job read as an unguarded one.
 */
const splitJob = (jobBody) => {
  const header = [];
  const steps = [];
  // Each step carries the indent of its OWN keys, which is the dash indent plus two. A step list
  // written at its key's own indent has 4-column keys and a step list written conventionally has
  // 8-column keys, so the value is recorded per step rather than assumed once.
  let step = null;
  let stepIndent = null;
  let inSteps = false;

  const flush = () => {
    if (step !== null) {
      steps.push({ text: step.join("\n"), keyIndent: stepIndent + 2 });
      step = null;
    }
  };

  for (const line of jobBody.split("\n")) {
    if (/^ {4}steps:/.test(line)) {
      flush();
      inSteps = true;
      header.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const startsStep =
      /^ *- /.test(line) &&
      indent <= 6 &&
      (stepIndent === null || indent === stepIndent);
    if (inSteps && startsStep) {
      if (stepIndent === null) stepIndent = indent;
      flush();
      step = [line];
      continue;
    }
    // A non-blank line at 4 columns or shallower, that is not a step, is the job's next key. This
    // is what ends the step list, and dropping it lets a later `env:` value read as a job gate.
    if (inSteps && line.trim() !== "" && indent <= 4) {
      flush();
      inSteps = false;
    }
    if (step !== null) step.push(line);
    else header.push(line);
  }
  flush();
  return { header: header.join("\n"), steps };
};

/**
 * A step with its leading dash replaced by indentation, so the step's own keys sit where a
 * mapping's keys sit, and every one of them at the same column.
 *
 * Only the FIRST line is rewritten: a `- ` deeper in the block belongs to a nested list or a shell
 * body, and shifting it left would move text the parser then misreads. `keyIndent` comes from the
 * step's own dash rather than a constant, so a step written at its key's own indent still has its
 * keys where `ifConditionAt` looks for them, and the whitespace after the dash is consumed so
 * `-   if:` lands on the same column as `- if:`.
 */
const undashStep = (step, keyIndent) =>
  step.replace(/^ *-\s+/, " ".repeat(keyIndent));

const readsSecret = (text, secret) => text.includes(`secrets.${secret}`);

/**
 * Whether `job` is really gated, rather than merely mentioning the guard.
 *
 * Two things a text search over the job body cannot tell apart, and both are what a plausible edit
 * produces: the guard is PROSE (a comment, a `run:` body, a `name:`), or it is on a DIFFERENT unit
 * than the one that reads the secret. So the guard has to be the value of an `if:` key, and it has
 * to gate the unit that reads.
 *
 * A job-level `if:` gates everything, including the reads no step can reach -- a job-level `env:`,
 * and a `uses:` caller's `secrets:` block. That makes it the whole answer when the guard is in it,
 * which is the shape the real workflow uses. Failing that, a read in the header has nothing that
 * could gate it, and a read in a step must carry the step's own condition.
 *
 * Anything this cannot attribute to a unit REJECTS. A gate that admits too much is the cheaper
 * mistake here: a gate that rejects a correctly guarded workflow teaches its author to delete a
 * real guard.
 *
 * "Cannot attribute" is not hypothetical. A step written in flow style (`- { if: ..., run: ... }`)
 * is not recognised as a step at all -- the dash is followed by `{`, not a space -- so its secret
 * reads as a header read and the job is rejected. Prettier normalises that spelling, and no
 * workflow here uses it, but it is the shape that fails closed.
 */
const jobIsForkGated = (jobBody, secret) => {
  const code = stripYamlComments(jobBody);
  if (FORK_GUARD_RE.test(ifConditionAt(code, 4))) return true;
  const { header, steps } = splitJob(code);
  if (readsSecret(header, secret)) return false;
  const readers = steps.filter((step) => readsSecret(step.text, secret));
  if (readers.length === 0) return false;
  return readers.every((step) =>
    FORK_GUARD_RE.test(
      ifConditionAt(undashStep(step.text, step.keyIndent), step.keyIndent),
    ),
  );
};

// Every job that reads a provider secret is behind the origin guard. Asserting the guard and the
// secret separately proves only that both exist somewhere in the file, which is what a secret
// moved into an unguarded job, or an unguarded job added next to a guarded one, would pass.
// Proving they are in the same JOB is necessary but not sufficient, and proving the guard is in
// the job at all is weaker still -- see `jobIsForkGated` for the shapes that mention the guard
// without being gated by it.
const assertSecretsStayInsideTheGuardedJob = (workflowText, secret) => {
  const jobs = workflowJobs(workflowText);
  assert.ok(jobs.length > 0, "the workflow must declare at least one job");
  const readers = jobs.filter((job) => job.body.includes(`secrets.${secret}`));
  assert.ok(readers.length > 0, `the workflow must still read ${secret}`);
  for (const { name, body } of readers) {
    assert.ok(
      jobIsForkGated(body, secret),
      `job ${name} reads ${secret} without the fork guard that protects it`,
    );
  }
};

// The Linux and Windows overlays do not call `pill_process` themselves. Both
// glob-re-export the shared notifier module, so the reset route reaches them
// only through that glob, and the glob carries `notify_reset_position` only if
// the module re-exports the name itself. Asserting the name anywhere in
// `common.rs` would not prove either half: a doc comment on the module, or the
// name left off the list, both read the same. Two tests below depend on this
// route, so it is asserted once, here, rather than copied into each.
const assertGlobReexportCarriesReset = () => {
  for (const [platform, overlay] of [
    ["linux", source.linuxOverlay],
    ["windows", source.windowsOverlay],
  ]) {
    assert.match(
      overlay,
      /pub use crate::platform::common::notifications::\*/,
      `the ${platform} overlay must re-export the shared reset notifier`,
    );
  }
  assert.match(
    source.commonPlatform,
    /pub use crate::pill_process::\{[^}]*\bnotify_reset_position\b[^}]*\};/,
    "the shared notifier module must re-export the reset command to the platforms that glob-import it",
  );
};

describe("PR28 native reset contracts", () => {
  it("routes the reset command through every platform overlay", () => {
    assert.match(
      source.commands,
      /crate::platform::overlay::notify_reset_position\(&app, &strategy\)/,
    );
    assert.match(
      source.macOverlay,
      /pill\.send\(InMessage::ResetPosition \{ strategy \}\)/,
    );
    assertGlobReexportCarriesReset();
    assert.match(source.macPill, /InMessage::ResetPosition \{ strategy \}/);
  });

  it("keeps tray reset state synchronized after native position events", () => {
    assert.match(source.tray, /RESET_PILL_POSITION_MENU_ID/);
    assert.match(source.tray, /set_reset_pill_position_enabled/);
    assert.match(source.effects, /tray-reset-pill-position/);
    assert.match(source.effects, /pill-position-changed/);
    assert.match(source.effects, /set_reset_pill_position_enabled/);
  });
});

describe("PR28 reset IPC execution and missing-overlay handling", () => {
  it("dispatches reset_position to every native pill and survives a closed overlay", () => {
    // Frontend forwards the tray reset through the Tauri command.
    assert.match(source.effects, /tray-reset-pill-position/);
    assert.match(
      source.effects,
      /invoke\("reset_pill_position", \{ strategy \}\)/,
    );
    // The Rust command emits a typed reset_position payload to the pill
    // process and returns an error (not a panic) when no pill is managed.
    // `commands.rs` returns that `Result` straight out of a `#[tauri::command]`,
    // so the return type is part of the contract and is pinned with the
    // parameters.
    assert.match(
      source.pillProcess,
      /pub fn notify_reset_position\(app: &tauri::AppHandle, strategy: &str\) -> Result<\(\), String>/,
    );
    assert.match(source.pillProcess, /"type":"reset_position"/);
    assert.match(
      source.pillProcess,
      /try_state::<std::sync::Arc<PillProcess>>\(\)/,
    );
    assert.match(
      source.pillProcess,
      /Reset position requested with no managed pill process/,
    );
    // Each platform overlay routes the reset into its pill channel.
    assert.match(
      source.macOverlay,
      /pill\.send\(InMessage::ResetPosition \{ strategy \}\)/,
    );
    // Both overlays re-export the shared notifiers with a glob rather than
    // naming each one, so the route lives in the module they pull from. What the
    // contract needs is that the name resolves for a caller of the platform
    // overlay module, which is what these check together.
    assertGlobReexportCarriesReset();
    assert.match(
      source.gtkPill,
      // The X11 drop position is still persisted through the shared
      // clear_pointer_pin teardown, which the release handler, the motion
      // stale-pin check, and the missed-release backstop all call. The
      // persist_drop_position call itself moved into the x11 module, so it
      // no longer carries the x11:: prefix at its pill.rs call sites.
      /clear_pointer_pin\(/,
    );
    assert.match(source.gtkX11, /x11_release_persisted\.set\(true\)/);
    assert.match(source.gtkX11, /pub\(crate\) fn persist_drop_position/);
    assert.match(
      source.gtkX11,
      /!state_tick\.x11_release_persisted\.replace\(false\)/,
    );
  });

  it("emits the frontend reset state event after a native position change", () => {
    // Native position change -> frontend enables/disables the tray reset item.
    assert.match(source.effects, /pill-position-changed/);
    assert.match(source.effects, /invoke\("set_reset_pill_position_enabled"/);
    // The command that the frontend invokes is registered in commands.rs.
    assert.match(source.commands, /reset_pill_position/);
    assert.match(source.commands, /set_reset_pill_position_enabled/);
  });
});

describe("PR28 ring-alpha render-loop policy", () => {
  it("advances the ring every frame and invalidates on the zero crossing", () => {
    // Every platform routes its per-frame ring bookkeeping through the shared
    // policy, so their timing cannot drift apart.
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      assert.match(pill, /advance_ring/);
      assert.match(pill, /fn tick_ring/);
    }
    // GTK redraws the drawing area after updating alpha.
    assert.match(source.gtkPill, /da\.queue_draw\(\)/);
    // macOS marks the layer dirty after updating alpha.
    assert.match(source.macApp, /setNeedsDisplay:YES/);
    // Windows must dirty the frame when the ring AND its arm pulse finish, so
    // the final cleared frame repaints instead of leaving a ghost.
    assert.match(
      source.windowsPill,
      /previous_alpha > 0\.0 && anim\.alpha == 0\.0/,
    );
    assert.match(
      source.windowsPill,
      /was_pulsing && !rust_pill_shared::pulse_is_running\(anim\.arm_pulse\)/,
    );
    assert.match(source.windowsPill, /dirty\.set\(true\)/);
    // Shared fade policy stays unit-tested in the pill crate.
    assert.match(
      source.sharedPill,
      /ring_alpha_fades_monotonically_after_release/,
    );
    assert.match(
      source.sharedPill,
      /advance_ring_pins_alpha_while_held_and_fades_after/,
    );
  });

  it("draws the ring from one continuous driver with no armed-state switch", () => {
    // The comet envelope must seal into a uniform outline as the hold
    // completes; a separate "armed" branch would reintroduce the visible cut
    // between filling and armed that this design removes.
    assert.match(source.sharedPill, /pub fn ring_envelope/);
    assert.match(source.sharedPill, /pub fn ring_seal/);
    assert.match(source.sharedPill, /envelope_seals_the_seam_at_completion/);
    assert.match(source.sharedPill, /sealing_strictly_reduces_the_seam_step/);
    // The glimmer replaces the old binary dash pattern and must stay
    // continuous across the seam, which requires whole cycles.
    assert.match(source.sharedPill, /pub fn ring_glimmer/);
    assert.match(source.sharedPill, /glimmer_is_continuous_across_the_seam/);
    assert.doesNotMatch(source.sharedPill, /ring_dash_is_on/);
    // The head must be gone before completion so nothing is parked at the seam.
    assert.match(source.sharedPill, /head_is_fully_gone_before_completion/);

    for (const draw of [source.gtkDraw, source.macDraw, source.windowsDraw]) {
      assert.match(draw, /ring_envelope/);
      assert.match(draw, /ring_glimmer/);
      // The head fade is centralized in rust_pill_shared::RingLayers; the
      // draw files consume it via head_discs() (A13 refactor).
      assert.match(draw, /head_discs\(\)/);
      // The retired dash renderer must not linger anywhere.
      assert.doesNotMatch(draw, /ring_dash_is_on/);
      assert.doesNotMatch(draw, /RING_SHIMMER_ALPHA/);
    }
  });

  it("reuses one buffer for the resampled ring instead of allocating per frame", () => {
    assert.match(source.sharedPill, /pub fn resample_perimeter/);
    assert.match(source.sharedPill, /resample_reuses_the_caller_buffer/);
    for (const state of [
      source.gtkState,
      source.macState,
      source.windowsState,
    ]) {
      assert.match(state, /ring_points:\s*RefCell<Vec<\(f64,\s*f64,\s*f64\)>>/);
    }
    for (const draw of [source.gtkDraw, source.macDraw, source.windowsDraw]) {
      assert.match(draw, /ring_points\.borrow_mut\(\)/);
    }
  });

  it("starts inflating mid-hold so arming continues the motion", () => {
    assert.match(source.sharedPill, /pub fn inflate_target/);
    assert.match(source.sharedPill, /inflate_starts_midway_through_the_hold/);
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      assert.match(pill, /rust_pill_shared::inflate_target\(/);
      // The old binary "1.0 while dragging" target is gone.
      assert.doesNotMatch(
        pill,
        /let inflate_target\s*=\s*if state\.dragging\.get\(\)\s*\{\s*1\.0\s*\}\s*else\s*\{\s*0\.0\s*\};/,
      );
    }
  });

  it("keeps the pill hovered while the button is held", () => {
    // Dragging moves the pill's own window, so a fast drag outruns it and the
    // cursor hit test misses. Trusting that would collapse the pill to its
    // unhovered size mid-gesture and re-expand it on release.
    assert.match(source.sharedHover, /pub struct HoverIntent/);
    assert.match(
      source.sharedHover,
      /pub fn advance\(&mut self, frame: &HoverFrame\)/,
    );
    assert.match(source.sharedHover, /fn enters_after_dwell_not_before/);
    assert.match(source.sharedHover, /fn fast_pass_never_arms/);
    assert.match(
      source.sharedHover,
      /fn pin_holds_while_down_regardless_of_probe/,
    );

    // The gate must be `pointer_down`, NOT the gesture flags. Moving past the
    // cancel threshold before the hold completes clears `long_press_active`
    // without setting `dragging`, so a gesture-keyed gate drops the pin while
    // the button is still down, which is the "drag across without releasing"
    // collapse.
    assert.match(source.sharedHover, /fn release_outside_exits_after_grace/);
    assert.match(source.sharedHover, /pub probed: bool/);
    assert.match(source.sharedHover, /pub pointer_down: bool/);
    assert.match(source.sharedHover, /pub entered: bool/);
    assert.match(source.sharedHover, /pub exited: bool/);

    for (const [pill, state] of [
      [source.gtkPill, source.gtkState],
      [source.macPill, source.macState],
      [source.windowsPill, source.windowsState],
    ]) {
      assert.match(state, /pointer_down: Cell<bool>/);
      assert.match(pill, /hover_intent\.borrow_mut\(\)\.advance\(/);
      assert.match(pill, /pointer_down\.get\(\)/);
      assert.match(pill, /pointer_down\.set\(true\)/);
      assert.match(pill, /pointer_down\.set\(false\)/);
      // The hover IPC fires only on entered/exited edges, so each transition
      // reports exactly once instead of every frame.
      assert.match(pill, /output\.entered \|\| output\.exited/);
    }

    // The pin must be released when the button comes up, or a drag finishing
    // away from the pill would leave it stuck open.
    assert.match(source.macApp, /update_hover\(ctx\.view, ctx\);/);
    // Probes feed the shared controller, which decides once per frame.
    assert.match(source.gtkPill, /input::is_over_pill_area/);
    assert.match(source.windowsPill, /check_hover\(hwnd, state\);/);

    // A release event can be missed (stolen grab, locked session), so every
    // platform polls the real button state as a backstop.
    assert.match(source.macApp, /fn release_pointer_if_button_up/);
    assert.match(source.macApp, /pressedMouseButtons/);
    assert.match(source.gtkPill, /BUTTON1_MASK/);
    assert.match(source.windowsPill, /fn tick_drag_release_fallback/);
    assert.match(
      source.windowsPill,
      /!state\.dragging\.get\(\)\s*&&\s*!state\.long_press_active\.get\(\)\s*&&\s*!state\.pointer_down\.get\(\)/,
    );
  });

  it("confirms the arm with a pulse that survives the ring's own alpha", () => {
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      assert.match(pill, /arm_pulse\.set\(rust_pill_shared::pulse_armed\(\)\)/);
      // The idle sentinel is named, never an open-coded -1.0.
      assert.match(
        pill,
        /arm_pulse: Cell::new\(rust_pill_shared::PULSE_IDLE\)/,
      );
    }
    // The sentinel is negative because 0.0 is a real value (the frame the pulse
    // starts), so every read goes through the named predicate rather than a
    // bare comparison that could be written backwards.
    assert.match(source.sharedPill, /pub const PULSE_IDLE:\s*f64\s*=\s*-1\.0;/);
    assert.match(source.sharedPill, /pub fn pulse_is_running/);
    assert.match(source.sharedPill, /pub fn pulse_armed/);
    // Every source must keep the pulse alive for its full duration, since it
    // outlives the ring's own alpha. Each platform therefore needs a liveness
    // check. Windows is the strictest case: it culls frames aggressively, so
    // without its own check the pulse would be dropped mid-flight.
    for (const src of [
      source.windowsState,
      source.windowsDraw,
      source.macDraw,
      source.gtkDraw,
    ]) {
      assert.match(src, /pulse_is_running\(/);
    }
  });
});

describe("PR28 fork-workflow secret isolation", () => {
  it("skips secret-backed jobs on fork pull requests via event fixtures", () => {
    const shouldRunProviderJob = (event) =>
      event.event_name === "push" ||
      (event.event_name === "pull_request" &&
        event.pull_request?.head?.repo?.full_name === event.repository);

    assert.equal(
      shouldRunProviderJob({
        event_name: "push",
        repository: "maus-inc/mausVoice",
      }),
      true,
    );
    assert.equal(
      shouldRunProviderJob({
        event_name: "pull_request",
        repository: "maus-inc/mausVoice",
        pull_request: { head: { repo: { full_name: "maus-inc/mausVoice" } } },
      }),
      true,
    );
    assert.equal(
      shouldRunProviderJob({
        event_name: "pull_request",
        repository: "maus-inc/mausVoice",
        pull_request: {
          head: { repo: { full_name: "contributor/mausVoice" } },
        },
      }),
      false,
    );

    // The guard inspects the actual pull_request head repo, not a constant.
    assert.match(
      source.integrationWorkflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    // Secrets are only referenced inside that guarded job.
    assertSecretsStayInsideTheGuardedJob(
      source.integrationWorkflow,
      "GROQ_API_KEY",
    );
    assert.match(
      source.integrationWorkflow,
      /if:\s*\|\s*github\.event_name == 'push' \|\|\s*\(github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/,
    );
  });
});

describe("PR28 removed-enterprise-docs contracts", () => {
  it("removes the docs tree and all public navigation references", () => {
    assert.equal(
      existsSync(resolve(repoRoot, "apps/docs/src/content/docs/enterprise")),
      false,
    );
    assert.doesNotMatch(source.astro, /enterprise/i);
    assert.doesNotMatch(source.docsIndex, /Enterprise/);
    assert.doesNotMatch(
      source.docsLlms,
      /maus-inc\.github\.io\/mausVoice\/enterprise\//,
    );
    assert.doesNotMatch(source.docsRobots, /enterprise documentation/i);
  });
});

describe("PR28 native placement contracts", () => {
  it("retains scale-aware placement and visible-footprint clamping", () => {
    assert.match(source.gtkX11, /scale_factor\(\)/);
    assert.match(source.gtkX11, /pill_pos_on_monitor/);
    assert.match(source.windowsPill, /MonitorFromPoint/);
    assert.match(source.windowsPill, /min_x/);
    assert.match(source.windowsPill, /min_y/);
    assert.match(source.macPill, /visible\.origin/);
  });

  it("has monitor-disconnect recovery on every native platform", () => {
    assert.match(source.gtkPill, /still_connected/);
    // macOS resolves the containing screen into `chosen`, carrying that
    // screen's visible frame. A display unplugged mid-drag leaves no screen
    // containing the anchor, so the match arm falls back to the primary
    // screen's visible frame instead of freezing at stale coordinates.
    assert.match(source.macPill, /match chosen \{/);
    assert.match(source.macPill, /None if count > 0 =>/);
    assert.match(
      source.macPill,
      /let visible = screen_visible_frame\(primary\)/,
    );
    assert.match(source.macPill, /primary/);
    assert.match(source.windowsPill, /MONITOR_DEFAULTTONEAREST/);
  });

  it("keeps the long-press ring alive during drag and fades it after release", () => {
    for (const state of [
      source.gtkState,
      source.macState,
      source.windowsState,
    ]) {
      assert.match(state, /ring_alpha/);
      assert.match(state, /LONG_PRESS_RING_FADE/);
    }
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      // Alpha is now advanced through the shared per-frame policy, which pins
      // it while held and eases it out after release.
      assert.match(pill, /advance_ring/);
      assert.match(pill, /ring_release_progress/);
    }
    assert.match(source.sharedPill, /pub fn ring_alpha/);
    assert.match(source.sharedPill, /ring_alpha_is_pinned_while_held/);
    assert.match(
      source.sharedPill,
      /ring_alpha_fades_monotonically_after_release/,
    );
  });
});

describe("PR28 workflow and public-asset contracts", () => {
  it("does not expose provider secrets to fork pull requests", () => {
    assertSecretsStayInsideTheGuardedJob(
      source.integrationWorkflow,
      "GROQ_API_KEY",
    );
  });

  // Two findings, and they are not the same defect, so the tests below are not the remedy for
  // both. 4151834033 reported that the guard only had to exist SOMEWHERE in the workflow; that was
  // already addressed before this change by `workflowJobs`, which proves the guard and the secret
  // share a job. 4178853244 reported the narrower hole that survived it -- the guard was found
  // anywhere in that job's text, so a comment or a step that does not read the secret satisfied
  // it while the reading step ran unguarded on a fork. What follows covers the second, plus the
  // shapes a later round of review turned up in the first attempt at covering it.
  //
  // The checks here fall into nested describes, one per concern: the guard appearing in prose,
  // a trailing comment, a guard that is not on an `if:` key, a secret read where no step can gate
  // it, and the header/step boundary. The `it`s directly below are the shapes that apply to more
  // than one of those.
  describe("the fork guard must be a real condition that gates the reader", () => {
    const job = (name, body) =>
      ["name: test", "on: pull_request", "jobs:", `  ${name}:`, body].join("\n");

    // A `y` helper so no fixture body carries its own escape sequence.
    const y = (...lines) => lines.join("\n");

    // The guard must be an `if:` VALUE, not prose that merely contains the text. `if: always()`
    // with the guard in a trailing comment is the exact bypass class the job was opened to close,
    // and the real workflow puts a comment above its `if:`, which makes the trailing spelling the
    // natural next one to try.
    describe("a guard hidden in a trailing comment is not a guard", () => {
      it("rejects a job-level if whose condition is always() and whose guard is a comment", () => {
        const workflow = job(
          "provider",
          y(
            "    if: always()  # github.event.pull_request.head.repo.full_name == github.repository",
            "    steps:",
            "      - run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "the condition is always(); the guard is only a comment on it",
        );
      });

      it("rejects a step-level if whose condition is always() and whose guard is a comment", () => {
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - name: transcribe",
            "        if: always()  # github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "the step condition is always(); the guard is only a comment on it",
        );
      });

      it("rejects a guard that is a comment inside a run body", () => {
        const workflow = job(
          "provider",
          y(
            "    if: always()",
            "    steps:",
            "      - name: transcribe",
            "        run: |",
            "          # github.event.pull_request.head.repo.full_name == github.repository",
            "          echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "a comment in a run body is not a condition",
        );
      });

      it("still accepts a condition that carries the guard AND a trailing comment", () => {
        // The control: stripping the comment must not also strip the condition.
        const workflow = job(
          "provider",
          y(
            "    if: github.event.pull_request.head.repo.full_name == github.repository # forks skip",
            "    steps:",
            "      - run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });
    });

    // The step path matched the guard ANYWHERE in the job text, so a `run:` body, a `name:` or an
    // `env:` value that merely mentioned it counted. A guard has to sit on an `if:` key.
    describe("only an if: key is a guard", () => {
      it("rejects a guard that appears only in a step's run body", () => {
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - name: transcribe",
            "        run: |",
            "          echo gated on github.event.pull_request.head.repo.full_name == github.repository",
            "          pnpm run integration ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "the guard is prose in a run body, not a condition",
        );
      });

      it("rejects a guard that appears only in a step's name", () => {
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - name: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "a step name gates nothing",
        );
      });

      it("rejects a guard that appears only in a step's env value", () => {
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - name: transcribe",
            "        env:",
            "          NOTE: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "an env value is not a condition",
        );
      });

      it("accepts the guard on an if: key written on the dash line", () => {
        // The control, and a shape the real workflows use: the condition can be the step's own
        // first key, so there is no 8-space `if:` line for a key-anchored match to find.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });
    });

    // A secret can be read where no step can gate it: a job-level `env:`, or a `uses:` caller's
    // `secrets:` block. The pre-change check accepted those and an early rewrite rejected them,
    // which is the expensive direction -- an author facing a failing test on a correctly guarded
    // job deletes the guard.
    describe("a secret read outside a step needs a job-level guard", () => {
      it("accepts a guarded job that passes the secret through env", () => {
        const workflow = job(
          "provider",
          y(
            "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
            "    env:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
            "    steps:",
            "      - run: pnpm run integration",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded job that passes the secret to a reusable workflow", () => {
        const workflow = job(
          "provider",
          y(
            "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
            "    uses: maus-inc/mausVoice/.github/workflows/groq.yml@main",
            "    secrets:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("rejects an unguarded job that passes the secret through env", () => {
        const workflow = job(
          "provider",
          y(
            "    env:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
            "    steps:",
            "      - run: pnpm run integration",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "no step can gate a job-level env read",
        );
      });

      it("rejects an unguarded job that passes the secret to a reusable workflow", () => {
        const workflow = job(
          "provider",
          y(
            "    uses: maus-inc/mausVoice/.github/workflows/groq.yml@main",
            "    secrets:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "no step can gate a uses: caller's secrets block",
        );
      });

      it("accepts a job-level if written after steps", () => {
        // YAML mapping order carries no meaning, so a job-level `if:` after the step list is
        // still a job-level `if:`. Reading only the header above `steps:` rejects this.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - run: echo ${{ secrets.GROQ_API_KEY }}",
            "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a step list whose dashes sit at the key's own indent", () => {
        // Legal YAML, and a sequence item may sit at its parent key's indent. What this pins is
        // only that a job-level gate still wins when the dashes sit there -- the job below IS
        // gated at job level, so the answer is decided before the step split runs and hardcoding
        // the step indent to 6 leaves this test green. The step indent itself is pinned by the
        // step-level fixture in the nested describe below, which has no job-level gate at all.
        const workflow = job(
          "provider",
          y(
            "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
            "    steps:",
            "    - run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("rejects a job whose guard sits in an expression after the step list", () => {
        // Note what this does NOT pin: the reading step below is unguarded, so it is rejected
        // whether or not the step list ends where it should. Where the list ENDS is pinned by the
        // second fixture in the nested describe below, whose reading step carries its own guard.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - run: echo ${{ secrets.GROQ_API_KEY }}",
            "    env:",
            "      NOTE: github.event.pull_request.head.repo.full_name == github.repository",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "an env value after the steps is a job key, not a gate",
        );
      });
    });

    it("rejects a job whose only mention of the guard is a comment", () => {
      const workflow = job(
        "provider",
        [
          "    # fork code must not receive secrets, so this job is skipped when",
          "    # github.event.pull_request.head.repo.full_name == github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.throws(
        () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        /fork guard/,
        "a comment is not a guard",
      );
    });

    it("rejects a job whose guarded step does not read the secret", () => {
      const workflow = job(
        "provider",
        [
          "    steps:",
          "      - name: lint",
          "        if: github.event.pull_request.head.repo.full_name == github.repository",
          "        run: echo lint",
          "      - name: transcribe",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.throws(
        () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        /fork guard/,
        "a guard on a different step does not guard the reader",
      );
    });

    it("accepts a single-line job-level if carrying the guard", () => {
      // A check that only recognises the block-scalar form rejects correct workflow, which is
      // worse than a check that accepts too much: the author faces a failing test on a guarded
      // job, and the cheapest repair is to delete the guard. The single-line `if:` is the shape
      // most people actually write, so it has to be recognised too.
      const workflow = job(
        "provider",
        [
          "    if: github.event.pull_request.head.repo.full_name == github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.doesNotThrow(() =>
        assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
      );
    });

    it("accepts a single-line job-level if that gates by disjunction", () => {
      // The guard can also arrive as one half of a condition, which is how push-triggered jobs
      // are written: run on push, or on a pull request from the same repository.
      const workflow = job(
        "provider",
        [
          "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.doesNotThrow(() =>
        assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
      );
    });

    it("rejects a job-level if whose guard is negated", () => {
      // The control for the two above. `!=` names the same two paths but admits every FORK, so
      // matching on the bare token would accept it. Pins that the operator is part of the check.
      const workflow = job(
        "provider",
        [
          "    if: github.event.pull_request.head.repo.full_name != github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.throws(
        () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        /fork guard/,
        "a negated guard admits every fork",
      );
    });

    it("rejects a guard that is only a comment inside the reading step", () => {
      // A comment stripping pass that is never exercised is a pass that does nothing, so this
      // is the fixture that reaches the step-level path at all: there is NO job-level `if:`
      // here, so the reader step's own guard is the only thing that could admit the job.
      const workflow = job(
        "provider",
        [
          "    steps:",
          "      - name: transcribe",
          "        # github.event.pull_request.head.repo.full_name == github.repository",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.throws(
        () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        /fork guard/,
        "a comment inside the reading step is not a guard",
      );
    });

    it("rejects a job where one of two reading steps is unguarded", () => {
      // Pins `every` rather than `some`. With a single reader the two are indistinguishable --
      // both say "not gated" -- so a weakening from `every` to `some` would pass every other
      // fixture here.
      const workflow = job(
        "provider",
        [
          "    steps:",
          "      - name: guarded",
          "        if: github.event.pull_request.head.repo.full_name == github.repository",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
          "      - name: unguarded",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.throws(
        () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        /fork guard/,
        "one unguarded reader is enough to expose the secret",
      );
    });

    it("accepts a job where every reading step carries its own guard", () => {
      // The control for the pair above, so the two cannot be satisfied by rejecting everything.
      const workflow = job(
        "provider",
        [
          "    steps:",
          "      - name: first",
          "        if: github.event.pull_request.head.repo.full_name == github.repository",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
          "      - name: second",
          "        if: github.event.pull_request.head.repo.full_name == github.repository",
          "        run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.doesNotThrow(() =>
        assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
      );
    });

    it("accepts a block scalar body indented one column past its key", () => {
      // A block scalar's content must be deeper than its key, and one column is legal. The body
      // threshold is derived from the key's own indent rather than fixed at 6, so a 5-column body
      // under a 4-column `if:` is read as the condition instead of leaving the guard invisible
      // and the job looking ungated.
      const workflow = job(
        "provider",
        y(
          "    if: |",
          "     github.event_name == 'push' ||",
          "     (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ),
      );
      assert.doesNotThrow(() =>
        assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
      );
    });

    // Line endings and job keys. Both of these made the gate fail in a way that looked like the
    // author's problem rather than the check's: CRLF made every job look unguarded, and a comment
    // after a job key made the workflow look like it declared no job at all.
    describe("line endings and job keys", () => {
      const crlfJob = (name, bodyLines) =>
        [
          "name: test",
          "on: pull_request",
          "jobs:",
          `  ${name}:`,
          ...bodyLines,
        ].join("\r\n");

      it("accepts a guarded job written with CRLF line endings", () => {
        // Every pattern in the check is anchored per line and `.` does not match `\r`, so a CRLF
        // checkout used to fail every key pattern at once, find no `if:` anywhere, and report every
        // job as unguarded. The pre-change check was a substring match and did not care.
        const workflow = crlfJob("provider", [
          "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ]);
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("still rejects an unguarded job written with CRLF line endings", () => {
        // The control. Normalising line endings must not become a blanket accept.
        const workflow = crlfJob("provider", [
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ]);
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
        );
      });

      it("accepts a job whose key carries a trailing comment", () => {
        // `  provider:  # gated` was not recognised as a job, so the gate failed with "the
        // workflow must declare at least one job" -- an author who DID declare a job, told to
        // declare one.
        const workflow = y(
          "name: test",
          "on: pull_request",
          "jobs:",
          "  provider:  # reads a provider secret, so it is gated",
          "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });
    });

    // Which steps and which jobs count as readers. A reader test of `includes("secrets")` or of the
    // bare secret name, or a reader filter that keeps everything, all make an ordinary workflow
    // look unguarded. These are the shapes that catch them: a provider job with a lint step beside
    // its reader, a workflow with a second job that reads nothing, and a step reading a different
    // secret or merely printing this one.
    describe("which steps and which jobs count as readers", () => {
      const guard = "github.event.pull_request.head.repo.full_name == github.repository";

      it("accepts a guarded reader step beside an unguarded step that reads nothing", () => {
        // The ordinary shape of a provider workflow. A filter that treated every step as a reader
        // would reject this.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            `      - if: ${guard}`,
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
            "      - run: pnpm lint",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded reader job beside a second job that reads nothing", () => {
        // The workflow-level twin. The real integration workflow declares exactly one job, so
        // production data cannot catch a job filter that keeps every job.
        const workflow = y(
          "name: test",
          "on: pull_request",
          "jobs:",
          "  provider:",
          `    if: ${guard}`,
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
          "  docs:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: pnpm docs:build",
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded reader step beside a step reading a different secret", () => {
        // Matching the `secrets` prefix rather than `secrets.GROQ_API_KEY` would make the second
        // step a reader of this secret and reject a workflow that is correctly gated for it.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            `      - if: ${guard}`,
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
            "      - run: curl ${{ secrets.TAVILY_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded reader step beside a step that only prints the secret's name", () => {
        // The other direction: matching the bare name rather than the `secrets.` reference makes a
        // diagnostic `echo` a reader.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            `      - if: ${guard}`,
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
            "      - run: echo GROQ_API_KEY is configured in CI",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });
    });

    // Three parser spellings that each silently lose the guard. All fail closed, so each of these
    // rejects a workflow that is in fact gated.
    describe("spellings the condition parser must not lose", () => {
      const guard = "github.event.pull_request.head.repo.full_name == github.repository";

      it("accepts a guard inside a single-quoted scalar", () => {
        // `char === "'"` has to open quote state too. With only `"` tracked, the ` # ` inside this
        // string reads as a comment and the secret after it is truncated away.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            `      - if: ${guard}`,
            "        run: sh -c 'echo a # b ${{ secrets.GROQ_API_KEY }}'",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts an if: key written after more than one space past the dash", () => {
        // `-   if:` is three spaces wide. Consuming one space only leaves the key at column 10,
        // where the step's own key column no longer matches and the guard goes unseen.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            `      -   if: ${guard}`,
            "          run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guard split across the comparison in a block scalar", () => {
        // The condition's lines are joined with a space, so a guard written across a line break
        // reassembles. Joining with nothing leaves `==github.repository`, which is not the guard.
        const workflow = job(
          "provider",
          y(
            "    if: |",
            "      (github.event_name == 'pull_request' &&",
            "       github.event.pull_request.head.repo.full_name ==",
            "       github.repository)",
            "    steps:",
            "      - run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });
    });

    it("still accepts a job-level if that really gates the reader", () => {
      // The control: the shape the real workflow uses, so the fix cannot pass by rejecting
      // everything.
      const workflow = job(
        "provider",
        [
          "    if: |",
          "      github.event_name == 'push' ||",
          "      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)",
          "    steps:",
          "      - run: echo ${{ secrets.GROQ_API_KEY }}",
        ].join("\n"),
      );
      assert.doesNotThrow(() =>
        assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
      );
    });

    // Six fixtures written against MUTATIONS THAT SURVIVED the first proof. Each one failed to
    // kill its mutation because an earlier check already produced the same verdict, so the
    // mutation changed a behaviour nobody could observe. That is the state this project treats as
    // a missing test: the branch exists, and nothing pins it.
    describe("parsing the job: comments, the header and the steps", () => {
      it("accepts a guarded step whose secret is read inside a quoted shell string", () => {
        // Pins the quote handling in `commentStart`, and the `#` sits after a SPACE on purpose.
        // A `#` right after a quote is already spared by the whitespace rule, so that spelling left
        // the quote rule unpinned: deleting the entire quote state machine left the suite green.
        // Here the whitespace rule alone would truncate the line, so the quote rule is what decides
        // it -- and truncating loses the `secrets.` reference, which makes the job look like it has
        // no reader, which fails closed and rejects a job that is genuinely guarded.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: sh -c 'curl \"a # b\" -H \"auth: ${{ secrets.GROQ_API_KEY }}\"'",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded step whose secret follows an escaped quote and a hash", () => {
        // Pins the backslash rule in `commentStart`. Inside a YAML double-quoted scalar `\"` is an
        // escaped quote, so it does not close the scalar, and the ` # ` after it is data rather
        // than a comment. Reading `\"` as the closing quote ends the scalar early, the `#` that
        // follows reads as a comment, and the `secrets.` reference after it is truncated away --
        // which leaves the job looking like it has no reader and rejects a job that is guarded.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: \"echo \\\" # text\\\" ${{ secrets.GROQ_API_KEY }}\"",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a guarded step whose secret is read after a URL fragment", () => {
        // Pins the other half of YAML's comment rule: a `#` opens a comment only at the start of
        // a line or after whitespace, so the `#` in `http://host/#v1` is part of the string. A
        // reader that cuts there loses the `secrets.` reference that follows, the job then looks
        // like it has no reader, and a correctly guarded job is rejected -- failing closed is
        // right in general and still wrong here.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: curl http://host/#v1 --header auth:${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("rejects a guarded step when a job-level env read is not gated", () => {
        // Pins that a step's own condition does NOT gate a job-level `env:`. The check treats a
        // header read as ungateable by anything but a job-level `if:` -- a step condition names a
        // step, so it is not consulted for a value that lives above the step list. The step reads
        // the same secret and IS guarded, which is what makes the verdict depend on the header
        // check rather than on the step.
        const workflow = job(
          "provider",
          y(
            "    env:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "a step condition does not gate a job-level env",
        );
      });

      it("rejects a job whose only secret reference is inside a comment", () => {
        // The caller selects a job as a reader from the RAW body, so a job can reach the check
        // with nothing in the parsed code that reads anything. Fails closed rather than waving
        // through a reference it cannot place.
        const workflow = job(
          "provider",
          y(
            "    # this job used to read ${{ secrets.GROQ_API_KEY }} on every fork",
            "    steps:",
            "      - run: echo lint",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "a reference in a comment is not a gate and not a reader",
        );
      });

      it("accepts a step guard on a continuation line when dashes sit at the key's indent", () => {
        // The dash-line fixture below puts the guard on the `- ` line. This one puts it on the
        // step's next line instead, where the column is the step's OWN key indent -- 6 for a step
        // written at 4, not the 8 a hardcoded column would assume.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "    - run: echo ${{ secrets.GROQ_API_KEY }}",
            "      if: github.event.pull_request.head.repo.full_name == github.repository",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("accepts a step-level guard whose dashes sit at the key's own indent", () => {
        // The sibling of the job-level fixture above. There the job-level check answered first, so
        // the step indent was never exercised; here the STEP is the only gate, which is what makes
        // the verdict depend on the step split.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "    - if: github.event.pull_request.head.repo.full_name == github.repository",
            "      run: echo ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.doesNotThrow(() =>
          assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
        );
      });

      it("rejects a guarded step when the ungated job-level env read comes after steps", () => {
        // YAML mapping order carries no meaning, so the same job as the third fixture with its
        // keys in the other order must reach the same verdict. This is the pair that pins where
        // the step list ENDS: if it never ended, these trailing keys would be absorbed into the
        // preceding step and the step's own condition would be read as gating them.
        const workflow = job(
          "provider",
          y(
            "    steps:",
            "      - if: github.event.pull_request.head.repo.full_name == github.repository",
            "        run: echo ${{ secrets.GROQ_API_KEY }}",
            "    env:",
            "      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}",
          ),
        );
        assert.throws(
          () => assertSecretsStayInsideTheGuardedJob(workflow, "GROQ_API_KEY"),
          /fork guard/,
          "key order does not change whether the env read is gated",
        );
      });
    });
  });

  it("keeps docs checks non-executable at install time and checks internal links", () => {
    assert.match(source.docsWorkflow, /--ignore-scripts/);
    assert.match(source.docsWorkflow, /grep -RInE/);
    assert.match(source.docsWorkflow, /mausvoice-banner\.png/);
  });

  it("assembles a complete project-Pages artifact at the documented base", () => {
    assert.match(source.astro, /const docsBase = "\/mausVoice\/docs\/"/);
    assert.match(
      source.docsIndex,
      /link: \/mausVoice\/docs\/getting-started\//,
    );
    assert.match(source.docsWorkflow, /cp -r marketing publish\/marketing/);
    assert.match(
      source.docsWorkflow,
      /cp -r apps\/docs\/dist\/. publish\/docs\//,
    );
    assert.match(
      source.docsWorkflow,
      /publish\/docs\/assets\/mausvoice-banner\.png/,
    );
    assert.match(source.docsWorkflow, /publish\/docs\/assets\/fonts/);
    assert.match(
      source.docsWorkflow,
      /cp sitemap\.xml robots\.txt llms\.txt publish\//,
    );
    assert.match(source.docsWorkflow, /publish\/docs\/llms\.txt/);
  });

  it("keeps homepage motion, accessibility, and responsive fallbacks wired", () => {
    assert.match(source.index, /id="caption-toggle"/);
    assert.match(source.index, /aria-pressed="false"/);
    assert.match(source.index, /capTrack\.mode = show \? "showing" : "hidden"/);
    assert.match(source.index, /prefers-reduced-motion/);
    assert.match(source.index, /IntersectionObserver/);
    assert.match(
      source.index,
      /window\.addEventListener\("resize", sizeStage\)/,
    );
    assert.match(source.index, /class="skip-link"/);
    assert.match(source.index, /:focus-visible/);
  });

  it("keeps every social metadata consumer on the checked-in asset", () => {
    const asset = resolve(repoRoot, "docs/assets/mausvoice-banner.png");
    assert.equal(statSync(asset).isFile(), true);
    assert.match(source.index, /docs\/assets\/mausvoice-banner\.png/);
    assert.match(source.astro, /docsBase\}assets\/mausvoice-banner\.png/);
  });
});

await import("./pr37-contracts.test.mjs");

describe("native gesture adapter contracts", () => {
  it("rejects non-finite grab geometry before arming a drag", () => {
    const begin = source.sharedDrag
      .split("pub fn begin_drag(")[1]
      .split("pub fn push_sample(")[0];
    for (const field of ["grab_dx", "grab_dy", "window_x", "window_y"]) {
      assert.ok(begin.includes(`!${field}.is_finite()`));
    }
    assert.ok(
      begin.indexOf("is_finite()") <
        begin.indexOf("self.phase = DragPhase::Held"),
    );
  });

  it("holds unknown pointer frames before implicit re-grab arithmetic", () => {
    const advance = source.sharedDrag
      .split("pub fn advance(")[1]
      .split("fn track_held(")[0];
    assert.match(
      advance,
      /if frame\.held\s*&&\s*\(!frame\.pointer_x\.is_finite\(\) \|\| !frame\.pointer_y\.is_finite\(\)\)/,
    );
    assert.match(advance, /return self\.stationary_output\(\);/);
    assert.ok(
      advance.indexOf("return self.stationary_output()") <
        advance.indexOf("match self.phase"),
    );
  });
  for (const [platform, state] of [
    ["gtk", "state_tick"],
    ["mac", "ctx.state"],
  ]) {
    it(`cancels ${platform} pointer state rather than rearming a reset drag`, () => {
      const pill = source[`${platform}Pill`];
      const reset = pill
        .split("InMessage::ResetPosition { strategy } => {")[1]
        .split("InMessage::RequestPosition")[0];
      for (const field of ["dragging", "pointer_down", "long_press_active"]) {
        assert.ok(reset.includes(`${state}.${field}.set(false)`));
      }
      assert.ok(reset.includes(`${state}.drag_cancelled.set(true)`));
      if (platform === "gtk")
        assert.match(reset, /x11_release_persisted\.set\(true\)/);
      assert.match(pill, /if !was_dragging && !.*drag_cancelled\.get\(\)/);
    });
  }

  it("holds spring state before applying zero-time snap rules", () => {
    for (const name of ["spring_01", "spring_px"]) {
      const body = scope("sharedSpring", `pub fn ${name}(`);
      assert.match(
        body,
        /if !target\.is_finite\(\) \|\| step_dt == 0\.0 \{\s*return;/,
      );
      assert.ok(
        body.indexOf("step_dt == 0.0") < body.indexOf("spring_integrate("),
      );
    }
  });

  it("recovers invalid spring state without propagating it through integration", () => {
    const pure = scope("sharedSpring", "pub fn spring_integrate(");
    assert.match(
      pure,
      /if !value\.is_finite\(\) \{\s*return \(target, 0\.0\);/,
    );
    assert.match(pure, /velocity\.is_finite\(\)/);
  });
  for (const [platform, context] of [
    ["windows", "gfx"],
    ["mac", "ctx"],
    ["gtk", "cr"],
  ]) {
    it(`keeps ${platform} pill outlines inside the same crossing paint transform`, () => {
      const draw = source[`${platform}Draw`];
      const overlays =
        platform === "gtk"
          ? ["draw_pill", "draw_flash_blue"]
          : ["draw_pill", "draw_flash_blue", "draw_long_press_ring"];
      for (const overlay of overlays) {
        const expected = `paint_pill_attached(${context}, state, ww, wh, |${context}| { ${overlay}(${context}, state, ww, wh); });`;
        assert.ok(
          draw.replace(/\s+/g, " ").includes(expected),
          `${platform}:${overlay}`,
        );
      }
      const body = scope(`${platform}Draw`, "fn draw_pill(");
      assert.doesNotMatch(body, /crossing\.borrow\(\)/);
    });
  }

  it("cancels Windows gesture ownership before resetting its position", () => {
    const reset = source.windowsPill
      .split("InMessage::ResetPosition { strategy } => {")[1]
      .split("InMessage::RequestPosition")[0];
    assert.match(reset, /cancel_drag_gesture\(hwnd, state\)/);
    assert.ok(
      reset.indexOf("cancel_drag_gesture") <
        reset.indexOf("reposition_to_cursor_monitor"),
    );
    const cancel =
      source.windowsPill
        .split("fn cancel_drag_gesture(")[1]
        ?.split("fn end_drag(")[0] ?? "";
    for (const field of ["long_press_active", "pointer_down"]) {
      assert.ok(cancel.includes(`state.${field}.set(false)`));
    }
    assert.match(cancel, /end_drag\(hwnd, state, false\)/);
    assert.match(cancel, /state\.drag_motion\.borrow_mut\(\)\.reset\(\)/);
    assert.match(cancel, /state\.drag_cancelled\.set\(true\)/);
    assert.match(
      source.windowsPill,
      /if !was_dragging && !state\.drag_cancelled\.get\(\)/,
    );
  });

  it("measures Windows headroom from the current visible pill", () => {
    const tick = source.windowsPill
      .split("fn tick_selector_placement(")[1]
      .split("fn advance_selector_placement(")[0];
    assert.match(tick, /draw::pill_position\(/);
    assert.match(tick, /selector_space_above\([\s\S]*?pill_y/);
    const helper = source.windowsPill
      .split("fn selector_space_above(")[1]
      .split("fn tick_selector_placement(")[0];
    assert.doesNotMatch(helper, /PILL_AREA_HEIGHT/);
  });

  it("anchors the Windows selector to live pill geometry instead of its reserved strip", () => {
    assert.match(
      source.windowsDraw,
      /tooltip_rendered_origin\(\s*pill_position\(state, ww, wh\)/,
    );
    assert.doesNotMatch(
      source.windowsDraw,
      /draw_tooltip\(gfx, state, ww, pill_area_top\)/,
    );
  });
  it("uses a shared monotonic clock instead of macOS wall time", () => {
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      assert.match(pill, /rust_pill_shared::clock::monotonic_now/);
    }
    assert.doesNotMatch(source.macPill, /CFAbsoluteTimeGetCurrent/);
  });

  it("selects drag bounds using the shared release anchor on every absolute-position backend", () => {
    for (const pill of [source.gtkX11, source.macPill, source.windowsPill]) {
      assert.match(pill, /\.monitor_anchor\(/);
    }
  });

  it("advances GTK hold and ring animations with the measured frame step", () => {
    assert.match(source.gtkPill, /tick_long_press\(state, dt\)/);
    assert.match(source.gtkPill, /tick_ring\(state, dt\)/);
    assert.match(source.gtkPill, /delta_seconds: dt/);
  });

  it("interrupts a running settle when a new press starts", () => {
    for (const pill of [source.gtkPill, source.macPill, source.windowsPill]) {
      assert.match(pill, /\.interrupt_settle\(\)/);
    }
  });

  it("shares the X11 applied position with idle placement and retains monitor fallbacks", () => {
    assert.doesNotMatch(source.gtkX11, /let last_pos =/);
    assert.match(source.gtkX11, /state\.x11_drag_applied\.set\(init_pos\)/);
    assert.match(
      source.gtkX11,
      /let prev = state_tick\.x11_drag_applied\.get\(\)/,
    );
    const frame = source.gtkX11
      .split("pub(crate) fn tick_drag_frame(")[1]
      .split("pub(crate) fn setup_x11_window(")[0];
    assert.match(frame, /monitor_at_window/);
    assert.match(frame, /primary_monitor_bottom_centre/);
  });

  it("measures selector headroom before a saved drop and on Wayland", () => {
    const headroom = source.gtkPill
      .split("fn selector_headroom(")[1]
      .split("fn tick_selector_placement(")[0];
    assert.doesNotMatch(headroom, /has_saved_position|f64::INFINITY/);
    assert.match(headroom, /state\.x11_drag_applied\.get\(\)/);
    assert.match(headroom, /Backend::PlainWayland/);
    assert.match(headroom, /window\.allocated_height\(\)/);
  });

  it("shares macOS painted selector geometry with both hit paths", () => {
    assert.match(
      source.macDraw,
      /let \(tooltip_rx, tooltip_ry\) = tooltip_rendered_origin\(/,
    );
    assert.equal(
      (source.macInput.match(/tooltip_rendered_origin\(/g) ?? []).length,
      2,
    );
    assert.doesNotMatch(source.macInput, /placement::tooltip_origin/);
  });

  it("compensates macOS default placement for the below-content slot", () => {
    assert.match(
      source.macPill,
      /let ty = default_content_origin_y\(visible\.origin\.y, win_h\)/,
    );
    assert.match(
      source.macPill,
      /fn below_selector_slot_does_not_lift_the_content_canvas/,
    );
    assert.match(
      source.macPill,
      /fn native_entry_stays_inside_the_painted_input_row/,
    );
  });

  it("captures X11 grab offsets using the press surface rather than the destination monitor", () => {
    assert.match(
      source.gtkPill,
      /drag_press_offset\.set\(x11::physical_grab_offset/,
    );
    assert.match(source.gtkPill, /win_press\.scale_factor\(\)/);
    assert.equal(
      (source.gtkX11.match(/state\.drag_press_offset\.get\(\)/g) ?? []).length,
      2,
    );
    assert.doesNotMatch(
      source.gtkX11,
      /drag_cursor_[xy]\.get\(\)\s*\*\s*p\.scale/,
    );
  });

  it("refreshes GTK selector action targets before press and release dispatch", () => {
    assert.equal(
      (
        source.gtkInput.match(
          /crate::draw::refresh_selector_click_regions\(state\)/g,
        ) ?? []
      ).length,
      2,
    );
    for (const name of ["is_on_pill_at", "handle_click"]) {
      // Scoped to the function, and both names asserted present inside it:
      // `indexOf` alone reports -1 for an absent name, which would satisfy the
      // ordering below on any body that dropped the refresh.
      const body = scope("gtkInput", `fn ${name}(`);
      const refresh = body.indexOf("refresh_selector_click_regions");
      const borrow = body.indexOf("state.click_regions.borrow()");
      assert.notEqual(refresh, -1, `${name} must refresh the click regions`);
      assert.notEqual(borrow, -1, `${name} must read the click regions`);
      assert.ok(refresh < borrow, `${name} must refresh before it reads`);
    }
  });

  it("invalidates Windows painting when selector placement changes without velocity", () => {
    const body = scope("windowsPill", "fn tick_selector_placement(");
    assert.match(body, /let changed = advance_selector_placement/);
    assert.match(body, /if changed \{\s*state\.dirty\.set\(true\)/);
  });

  it("uses the created Windows height for initial placement", () => {
    assert.match(
      source.windowsPill,
      /let \(wx, wy\) = initial_position\(win_h\)/,
    );
    const body = scope("windowsPill", "fn initial_position(");
    assert.match(body, /default_pill_y\(wa\.top, wa_h, win_h\)/);
  });

  it("anchors macOS selector geometry to the live pill instead of the area strip", () => {
    const origin = source.macDraw
      .split("pub(crate) fn tooltip_rendered_origin(")[1]
      .split("fn draw_tooltip(")[0];
    assert.doesNotMatch(origin, /PILL_AREA_HEIGHT/);
    assert.match(
      source.macDraw,
      /pill_position\(state, ww, wh\), tooltip_w, tooltip_t, blend/,
    );
    assert.match(source.macInput, /refresh_selector_click_regions\(state\)/);
  });

  it("uses full macOS screen identity and keeps the x axis unchanged", () => {
    const crossing = source.macPill
      .split("unsafe fn pill_center_monitor(")[1]
      .split("fn tick(")[0];
    assert.doesNotMatch(crossing, /screen_visible_frame|primary_top - cx_up/);
    assert.match(
      crossing,
      /crossing_identity\(frame, primary_top, cx_up, cy_up\)/,
    );
  });

  it("samples macOS crossing geometry after rehoming rather than before", () => {
    const perform = source.macPill
      .split("fn perform_tick()")[1]
      .split("fn end_drag(")[0];
    const reposition = perform.indexOf("reposition_window(");
    const spatial = perform.indexOf("tick_spatial_feedback(");
    assert.ok(reposition >= 0 && spatial > reposition);
  });

  it("leaves monitor gaps unknown for Windows crossing detection", () => {
    const lookup = source.windowsPill
      .split("fn monitor_geometry_at(")[1]
      .split("fn tick_crossing(")[0];
    assert.match(lookup, /MONITOR_DEFAULTTONULL/);
    assert.doesNotMatch(lookup, /MONITOR_DEFAULTTONEAREST/);
  });

  it("repaints Windows when crossing deformation snaps back to rest", () => {
    const tick = source.windowsPill
      .split("fn tick_crossing(")[1]
      .split("fn tick_long_press(")[0];
    assert.match(tick, /let \(out, changed\) = advance_crossing\(/);
    assert.match(tick, /if changed \{\s*state\.dirty\.set\(true\)/);
    assert.match(tick, /before != \(output\.scale_x, output\.scale_y\)/);
  });

  it("reports Cairo's latched errors at the frame boundary with a rate limit", () => {
    assert.match(source.gtkPill, /if let Err\(error\) = cr\.status\(\)/);
    assert.match(
      source.gtkPill,
      /last_draw_error\.get\(\).*Duration::from_secs\(2\)/,
    );
    assert.match(source.gtkPill, /last_draw_error\.set\(Some\(now\)\)/);
  });

  it("aborts failed Cairo saves before applying frame or crossing transforms", () => {
    assert.match(
      source.gtkDraw,
      /if cr\.save\(\)\.is_err\(\) \{\s*return;\s*\}\s*cr\.translate\(ox, oy\)/,
    );
    assert.match(
      source.gtkDraw,
      /if cr\.save\(\)\.is_err\(\) \{\s*return;\s*\}\s*cr\.translate\(dcx, dcy\)/,
    );
  });

  it("initializes the optional edge policy in the subframe native fixture", () => {
    const fixture = source.sharedDrag
      .split(
        "fn subframe_flick_completes_a_settle_from_the_tracked_position()",
      )[1]
      .split("drag.end_drag(")[0];
    assert.match(fixture, /edge_work: None/);
  });

  it("uses centered Windows scaling for both crossing and flash paint", () => {
    assert.match(source.windowsGfx, /Matrix3x2::scale_around/);
    assert.match(source.windowsDraw, /gfx\.scale_around\(dcx, dcy, dsx, dsy\)/);
    assert.match(
      source.windowsDraw,
      /gfx\.scale_around\(center_x, center_y, scale, scale\)/,
    );
  });

  it("uses the visible X11 pill monitor before the transparent host for placement", () => {
    const monitor = source.gtkPill
      .split("fn pill_monitor(")[1]
      .split("fn selector_visible_headroom(")[0];
    const visible = monitor.indexOf("x11_pill_monitor(window, state)");
    assert.ok(
      visible >= 0 && visible < monitor.indexOf("display.monitor_at_window"),
    );
  });

  it("rejects unknown updater channels before making a request", () => {
    const endpoint = source.commands
      .split("fn channel_manifest_url(")[1]
      .split("pub async fn check_for_channel_update(")[0];
    assert.match(endpoint, /"stable" => \{?\s*Ok\(/);
    assert.match(endpoint, /"beta" => Ok\(/);
    assert.match(endpoint, /_ => Err\("Unsupported update channel"\)/);
    assert.match(
      source.commands,
      /Url::parse\(channel_manifest_url\(channel.as_str\(\)\)\?\)/,
    );
  });

  it("resolves GTK crossing from the live physical window position, even before the first save", () => {
    // The live physical origin is read once in the shared center helper and
    // consumed by the monitor resolver. Assert both halves so the contract
    // pins that the seam math uses the applied drag origin, and not which
    // function the read happens to sit in.
    const center = source.gtkPill
      .split("pub(crate) fn x11_pill_center(")[1]
      .split("fn x11_pill_monitor(")[0];
    assert.match(center, /state\.x11_drag_applied\.get\(\)/);
    assert.doesNotMatch(
      center,
      /state\.(?:saved_x|saved_y|has_saved_position)/,
    );

    const crossing = source.gtkPill
      .split("fn x11_pill_monitor(")[1]
      .split("fn tick_crossing_frame(")[0];
    assert.match(crossing, /x11_pill_center\(state, scale\)\?/);
    assert.match(crossing, /center\.root\?/);
    assert.doesNotMatch(
      crossing,
      /state\.(?:saved_x|saved_y|has_saved_position)/,
    );
    assert.match(crossing, /x11::monitor_at_physical_point/);
    assert.match(
      source.gtkX11,
      /let monitor = monitor_at_physical_point\(display, anchor_x, anchor_y, scale\)\?/,
    );
  });

  it("parks and clamps Windows content without counting transparent selector rows", () => {
    assert.match(source.windowsPill, /win_h\.clamp\(0, WINDOW_H_TYPING\)/);
    assert.match(
      source.windowsPill,
      /work_area_height - content_canvas_height\(win_h\) - MARGIN_BOTTOM/,
    );
    assert.match(
      source.windowsPill,
      /wa\.bottom - content_canvas_height\(win_h\)/,
    );
  });

  it("reserves GTK selector rows outside the parked content canvas", () => {
    assert.match(
      source.gtkState,
      /content_canvas_height\(ah, below_slot\) - dh - MARGIN_BOTTOM/,
    );
    assert.match(
      source.gtkX11,
      /content_canvas_height\(\s*alloc_h as f64, state\.below_slot_extra\(\)/,
    );
    assert.match(source.gtkX11, /p\.work_h - p\.content_h - p\.margin/);
    assert.match(source.gtkPill, /ah - oy - dh/);
    assert.match(source.gtkInput, /ox as i32, oy as i32/);
  });

  it("edge-maps the settle target once rather than each spring output", () => {
    const settle = source.sharedDrag
      .split("fn track_settle(")[1]
      .split("fn estimate_velocity(")[0];
    assert.equal(settle.match(/ease_point\(/g)?.length, 1);
    const integration = settle.split("let (x, mut vx)")[1];
    assert.doesNotMatch(integration, /ease_point\(/);
    assert.match(integration, /clamp_point\(x, y\)/);
  });

  it("refreshes GTK hover after a missed release flushes the last drag move", () => {
    const backstop = source.gtkPill
      .split("fn release_pointer_if_button_up(")[1]
      .split("fn clear_flash(")[0];
    const afterRelease = backstop.split("clear_pointer_pin(state, window);")[1];
    assert.match(afterRelease, /device_position\(&pointer\)/);
    assert.match(
      afterRelease,
      /is_over_pill_area\(state, x as f64, y as f64\)/,
    );
    assert.match(afterRelease, /hover_probe_x\.set\(x as f64\)/);
    assert.match(afterRelease, /hover_probe_y\.set\(y as f64\)/);
  });

  it("does not emit repeated settle-completion signals from idle", () => {
    const idle = source.sharedDrag
      .split("DragPhase::Idle => {")[1]
      .split("DragPhase::Held => {")[0];
    assert.match(idle, /self\.stationary_output\(\)/);
    const stationary = source.sharedDrag
      .split("fn stationary_output(")[1]
      .split("fn track_held(")[0];
    assert.match(stationary, /settled: false/);
    assert.doesNotMatch(stationary, /settled: true/);
  });

  it("preserves cached Windows reduced motion on failed system queries", () => {
    assert.match(
      source.windowsPill,
      /update_reduced_motion_cache\(cache, query_client_area_animation\(\)\)/,
    );
    assert.match(
      source.windowsPill,
      /if let Some\(enabled\) = queried_animation \{\s*cache\.set\(!enabled\)/,
    );
  });

  it("queries Windows client-area animations rather than menu animations", () => {
    assert.match(
      source.windowsPill,
      /SystemParametersInfoW\(\s*SPI_GETCLIENTAREAANIMATION,/,
    );
    assert.doesNotMatch(source.windowsPill, /SPI_GETMENUANIMATION|0x1002/);
  });
});

describe("native review and monitor contracts", () => {
  it("passes localized Edit captions through all three native review payloads", () => {
    for (const platform of ["gtk", "macos", "windows"]) {
      const ipc = read(`packages/rust_${platform}_pill/src/ipc.rs`);
      const draw = read(`packages/rust_${platform}_pill/src/draw.rs`).split(
        "fn draw_review_actions(",
      )[1];
      assert.match(
        ipc,
        /#\[serde\(default\)\]\s*pub edit_label: Option<String>/,
      );
      assert.match(draw, /review\.edit_label\.as_deref\(\)/);
      assert.match(draw, /edit_label,\s*ClickAction::ReviewEdit/);
      assert.doesNotMatch(draw, /"Edit",\s*ClickAction::ReviewEdit/);
      assert.match(
        draw,
        /\(text_width \+ 20\.0\)\.max\(PERM_BUTTON_WIDTH \* 0\.8\)/,
      );
    }
  });

  it("centralizes fallible Win32 monitor-info initialization", () => {
    const pill = source.windowsPill;
    // `GetMonitorInfoW` belongs to the one wrapper, not to its callers.
    assert.equal(pill.match(/GetMonitorInfoW\(/g)?.length, 1);
    assert.ok((pill.match(/query_monitor_info\(/g)?.length ?? 0) >= 6);

    // A caller binds the info in one of two ways, and both have to guard: a
    // `?`, or a let-else whose block returns. Counting the two guarded shapes
    // separately is what makes this bite -- a new binding with neither leaves
    // one of them short of the total, and matching either shape on its own
    // proved nothing about the other call sites. The argument is matched as an
    // identifier rather than as the name `monitor`, because this same file
    // already calls the wrapper with `mon` in one place: pinning the name
    // would fail a guard that is proving the right thing about a renamed local.
    const argument = "\\([A-Za-z_][A-Za-z0-9_]*\\)";
    const bindings =
      (pill.match(/let Some\(info\) = query_monitor_info\(/g)?.length ?? 0) +
      (pill.match(/let info = query_monitor_info\(/g)?.length ?? 0);
    const guarded =
      (pill.match(
        new RegExp(`let info = query_monitor_info${argument}\\?;`, "g"),
      )?.length ?? 0) +
      (pill.match(
        new RegExp(
          `let Some\\(info\\) = query_monitor_info${argument} else \\{[^}]*return[^}]*\\};?`,
          "g",
        ),
      )?.length ?? 0);
    assert.ok(bindings > 0, "the wrapper's callers bind the info");
    assert.equal(
      guarded,
      bindings,
      "every info binding is guarded by ? or a let-else that returns",
    );
  });
});

describe("crossing boundary geometry", () => {
  it("passes full monitor dimensions instead of guessing normals from origins", () => {
    const shared = read("packages/rust_pill_shared/src/deform.rs");
    assert.match(shared, /pub monitor_width: f64/);
    assert.match(shared, /pub monitor_height: f64/);
    assert.match(shared, /fn boundary_axis\(/);
    assert.doesNotMatch(shared, /\(frame\.monitor_x - self\.mon_x\)\.abs\(\)/);
    for (const native of [source.gtkPill, source.macApp, source.windowsPill]) {
      assert.match(native, /monitor_width: /);
      assert.match(native, /monitor_height: /);
    }
  });
});

describe("selector transition visibility", () => {
  it("shares opacity between selector drawing and native hit paths", () => {
    const placement = read("packages/rust_pill_shared/src/placement.rs");
    assert.match(placement, /pub fn tooltip_opacity\(/);
    assert.doesNotMatch(placement, /above_y \+ \(below_y - above_y\) \* t/);
    for (const platform of ["gtk", "macos", "windows"]) {
      const state = read(`packages/rust_${platform}_pill/src/state.rs`);
      const draw = read(`packages/rust_${platform}_pill/src/draw.rs`);
      const input = read(`packages/rust_${platform}_pill/src/input.rs`);
      assert.match(state, /pub\(crate\) fn tooltip_opacity\(/);
      assert.match(draw, /let alpha = state\.tooltip_opacity\(\)/);
      assert.match(draw, /state\.tooltip_opacity\(\) </);
      assert.match(input, /refresh_selector_click_regions\(state\)/);
    }
    assert.match(
      source.gtkInput,
      /placement::tooltip_opacity\(tooltip_t, blend\)/,
    );
  });
});

describe("macOS saved-position scope", () => {
  it("starts unsaved and only captures origins from this instance's live canvas", () => {
    assert.match(source.macApp, /has_saved_position: Cell::new\(false\)/);
    assert.equal(source.macApp.match(/saved_x\.set\(/g)?.length, 1);
    assert.equal(source.macApp.match(/saved_y\.set\(/g)?.length, 1);
    const capture = source.macApp
      .split("fn persist_drag_position(")[1]
      .split("fn reduced_motion(")[0];
    assert.match(capture, /saved_x\.set\(frame\.origin\.x\)/);
    assert.match(capture, /saved_y\.set\(frame\.origin\.y\)/);
    assert.match(capture, /OutMessage::PositionChanged/);
    const desktopCache = read("apps/desktop/src/utils/composer.utils.ts")
      .split("export const setPillGeometry =")[1]
      .split("export const getComposerWindowPosition")[0];
    assert.match(desktopCache, /cachedPillRect = rect/);
    assert.doesNotMatch(desktopCache, /localStorage|invoke\(|writeFile/);
  });
});

describe("PR28 live audio chunk contract", () => {
  it("sends the sample offset the webview requires to accept a chunk", () => {
    // The webview discards any chunk whose offset is missing, because it
    // cannot prove the stream is contiguous. That makes the native payload's
    // `offset` field load bearing for whether live audio reaches a session at
    // all, so the field and the emitter that fills it are both pinned here.
    const payload = source.recording
      .split("pub struct AudioChunkPayload {")[1]
      .split("}")[0];
    assert.match(payload, /pub offset: u64/);

    assert.match(source.commands, /AudioChunkPayload \{ samples, offset \}/);
    assert.match(source.commands, /move \|samples: Vec<f32>, offset: u64\|/);
  });

  it("keeps the native and webview chunk contracts in step", () => {
    // `offset` is optional in the webview type so an older native build
    // degrades to a dropped chunk rather than a crash. The intake path must
    // therefore still guard on it, or the "optional" default silently
    // discards every chunk on a build that never sends one.
    assert.match(source.audioChunks, /offset\?: number/);
    assert.match(source.audioChunks, /payload\.offset \?\? null/);
    assert.match(source.intake, /if \(offset === null\)/);
  });
});
