import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const source = Object.fromEntries(
  [
    ["commands", "apps/desktop/src-tauri/src/commands.rs"],
    ["tray", "apps/desktop/src-tauri/src/system/tray.rs"],
    ["effects", "apps/desktop/src/components/root/AppSideEffects.tsx"],
    ["macOverlay", "apps/desktop/src-tauri/src/platform/macos/overlay.rs"],
    ["linuxOverlay", "apps/desktop/src-tauri/src/platform/linux/overlay.rs"],
    [
      "windowsOverlay",
      "apps/desktop/src-tauri/src/platform/windows/overlay.rs",
    ],
    ["macPill", "packages/rust_macos_pill/src/app.rs"],
    ["gtkPill", "packages/rust_gtk_pill/src/pill.rs"],
    ["gtkX11", "packages/rust_gtk_pill/src/x11.rs"],
    ["windowsPill", "packages/rust_windows_pill/src/pill.rs"],
    ["macApp", "packages/rust_macos_pill/src/app.rs"],
    ["pillProcess", "apps/desktop/src-tauri/src/pill_process.rs"],
    ["macState", "packages/rust_macos_pill/src/state.rs"],
    ["gtkState", "packages/rust_gtk_pill/src/state.rs"],
    ["windowsState", "packages/rust_windows_pill/src/state.rs"],
    ["sharedPill", "packages/rust_pill_shared/src/lib.rs"],
    ["macDraw", "packages/rust_macos_pill/src/draw.rs"],
    ["gtkDraw", "packages/rust_gtk_pill/src/draw.rs"],
    ["windowsDraw", "packages/rust_windows_pill/src/draw.rs"],
    ["integrationWorkflow", ".github/workflows/test-desktop-integration.yml"],
    ["docsWorkflow", ".github/workflows/test-docs.yml"],
    ["index", "index.html"],
    ["astro", "apps/docs/astro.config.mjs"],
    ["docsIndex", "apps/docs/src/content/docs/index.mdx"],
    ["docsLlms", "apps/docs/public/llms.txt"],
    ["docsRobots", "apps/docs/public/robots.txt"],
  ].map(([name, path]) => [name, read(path)]),
);

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
    assert.match(
      source.linuxOverlay,
      /pill_process::notify_reset_position\(app, strategy\)/,
    );
    assert.match(
      source.windowsOverlay,
      /pill_process::notify_reset_position\(app, strategy\)/,
    );
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
    assert.match(
      source.pillProcess,
      /pub fn notify_reset_position\(app: &tauri::AppHandle, strategy: &str\)/,
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
    assert.match(
      source.linuxOverlay,
      /pill_process::notify_reset_position\(app, strategy\)/,
    );
    assert.match(
      source.windowsOverlay,
      /pill_process::notify_reset_position\(app, strategy\)/,
    );
    assert.match(
      source.gtkPill,
      // The X11 drop position is still persisted (now via the shared
      // clear_pointer_pin teardown, which both the release handler and the
      // missed-release backstop call).
      /x11::persist_drop_position\(/,
    );
    assert.match(source.gtkPill, /x11_release_persisted\.set\(persisted\)/);
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
    assert.match(source.sharedPill, /pub fn resolve_hover/);
    assert.match(
      source.sharedPill,
      /hover_survives_a_drag_that_outruns_the_window/,
    );
    assert.match(
      source.sharedPill,
      /hover_follows_the_cursor_once_the_button_is_released/,
    );

    // The gate must be `pointer_down`, NOT the gesture flags. Moving past the
    // cancel threshold before the hold completes clears `long_press_active`
    // without setting `dragging`, so a gesture-keyed gate drops the pin while
    // the button is still down — the "drag across without releasing" collapse.
    assert.match(
      source.sharedPill,
      /hover_holds_when_a_cancelled_long_press_becomes_a_plain_drag/,
    );
    assert.match(
      source.sharedPill,
      /pub fn resolve_hover\(probed:\s*bool,\s*pointer_down:\s*bool\)/,
    );

    for (const [pill, state] of [
      [source.gtkPill, source.gtkState],
      [source.macPill, source.macState],
      [source.windowsPill, source.windowsState],
    ]) {
      assert.match(state, /pointer_down: Cell<bool>/);
      assert.match(pill, /resolve_hover\(/);
      assert.match(pill, /pointer_down\.get\(\)/);
      assert.match(pill, /pointer_down\.set\(true\)/);
      assert.match(pill, /pointer_down\.set\(false\)/);
      // A gesture-flag gate must not creep back in.
      assert.doesNotMatch(pill, /resolve_hover\([\s\S]{0,200}?gesture_active/);
    }

    // The pin must be released when the button comes up, or a drag finishing
    // away from the pill would leave it stuck open.
    assert.match(source.macApp, /update_hover\(ctx\.view, ctx\);/);
    assert.match(source.gtkPill, /let now_hovered = input::is_over_pill_area/);
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
    // check; Windows is the strictest case — it culls frames aggressively, so
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
    assert.match(source.integrationWorkflow, /GROQ_API_KEY/);
    assert.match(
      source.integrationWorkflow,
      /Keep fork PRs from[\s\S]*?withholds secrets/,
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
    assert.match(source.macPill, /chosen_visible/);
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
    assert.match(
      source.integrationWorkflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    assert.match(source.integrationWorkflow, /GROQ_API_KEY/);
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
