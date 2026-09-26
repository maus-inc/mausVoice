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
    // the button is still down — the "drag across without releasing" collapse.
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
    // A vanished screen falls back to the primary screen's visible frame.
    assert.match(source.macPill, /None if count > 0 =>/);
    assert.match(
      source.macPill,
      /let visible = screen_visible_frame\(primary\)/,
    );
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
      const body = source.sharedSpring
        .split(`pub fn ${name}(`)[1]
        .split("\n}")[0];
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
    const pure = source.sharedSpring
      .split("pub fn spring_integrate(")[1]
      .split("\n}")[0];
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
      const body = draw.split("fn draw_pill(")[1].split("\nfn ")[0];
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
      const body = source.gtkInput.split(`fn ${name}(`)[1].split("\n}")[0];
      assert.ok(
        body.indexOf("refresh_selector_click_regions") <
          body.indexOf("state.click_regions.borrow()"),
      );
    }
  });

  it("invalidates Windows painting when selector placement changes without velocity", () => {
    const body = source.windowsPill
      .split("fn tick_selector_placement(")[1]
      .split("\n}")[0];
    assert.match(body, /let changed = advance_selector_placement/);
    assert.match(body, /if changed \{\s*state\.dirty\.set\(true\)/);
  });

  it("uses the created Windows height for initial placement", () => {
    assert.match(
      source.windowsPill,
      /let \(wx, wy\) = initial_position\(win_h\)/,
    );
    const body = source.windowsPill
      .split("fn initial_position(")[1]
      .split("\n}")[0];
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
    assert.match(endpoint, /"stable" => Ok\(/);
    assert.match(endpoint, /"beta" => Ok\(/);
    assert.match(endpoint, /_ => Err\("Unsupported update channel"\)/);
    assert.match(
      source.commands,
      /Url::parse\(channel_manifest_url\(channel.as_str\(\)\)\?\)/,
    );
  });

  it("resolves GTK crossing from the live physical window position, even before the first save", () => {
    // `x11_pill_monitor` reads the live origin through `x11_pill_center`.
    const crossing = source.gtkPill
      .split("fn x11_pill_center(")[1]
      .split("fn tick_crossing_frame(")[0];
    assert.match(crossing, /state\.x11_drag_applied\.get\(\)/);
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
      assert.match(draw, /\(edit_label, ClickAction::ReviewEdit/);
      assert.doesNotMatch(draw, /\("Edit", ClickAction::ReviewEdit/);
      assert.match(
        draw,
        /\(text_width \+ 20\.0\)\.max\(PERM_BUTTON_WIDTH \* 0\.8\)/,
      );
    }
  });

  it("centralizes fallible Win32 monitor-info initialization", () => {
    assert.equal(source.windowsPill.match(/GetMonitorInfoW\(/g)?.length, 1);
    assert.ok(source.windowsPill.match(/query_monitor_info\(/g)?.length >= 6);
    assert.match(
      source.windowsPill,
      /let Some\(info\) = query_monitor_info\(monitor\) else \{ return \};/,
    );
    assert.match(
      source.windowsPill,
      /let info = query_monitor_info\(monitor\)\?;/,
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
