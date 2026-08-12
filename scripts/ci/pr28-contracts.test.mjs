import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
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
    ["macState", "packages/rust_macos_pill/src/state.rs"],
    ["gtkState", "packages/rust_gtk_pill/src/state.rs"],
    ["windowsState", "packages/rust_windows_pill/src/state.rs"],
    ["sharedPill", "packages/rust_pill_shared/src/lib.rs"],
    ["newServer", "apps/desktop/src/utils/new-server.utils.ts"],
    ["integrationWorkflow", ".github/workflows/test-desktop-integration.yml"],
    ["docsWorkflow", ".github/workflows/test-docs.yml"],
    ["index", "index.html"],
    ["astro", "apps/docs/astro.config.mjs"],
  ].map(([name, path]) => [name, read(path)]),
);

describe("PR28 native reset contracts", () => {
  it("routes the reset command through every platform overlay", () => {
    assert.match(
      source.commands,
      /crate::platform::overlay::notify_reset_position\(&app\)/,
    );
    assert.match(source.macOverlay, /pill\.send\(InMessage::ResetPosition\)/);
    assert.match(
      source.linuxOverlay,
      /pill_process::notify_reset_position\(app\)/,
    );
    assert.match(
      source.windowsOverlay,
      /pill_process::notify_reset_position\(app\)/,
    );
    assert.match(source.macPill, /InMessage::ResetPosition/);
  });

  it("keeps tray reset state synchronized after native position events", () => {
    assert.match(source.tray, /RESET_PILL_POSITION_MENU_ID/);
    assert.match(source.tray, /set_reset_pill_position_enabled/);
    assert.match(source.effects, /tray-reset-pill-position/);
    assert.match(source.effects, /pill-position-changed/);
    assert.match(source.effects, /set_reset_pill_position_enabled/);
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
      assert.match(pill, /update_ring_alpha/);
      assert.match(pill, /ring_release_progress/);
    }
    assert.match(source.sharedPill, /pub fn update_ring_alpha/);
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

  it("keeps every social metadata consumer on the checked-in asset", () => {
    const asset = resolve(repoRoot, "docs/assets/mausvoice-banner.png");
    assert.equal(statSync(asset).isFile(), true);
    assert.match(source.index, /docs\/assets\/mausvoice-banner\.png/);
    assert.match(source.astro, /docs\/assets\/mausvoice-banner\.png/);
  });

  it("keeps a valid production fallback for the new server", () => {
    assert.match(source.newServer, /DEFAULT_NEW_SERVER_URL/);
    assert.match(source.newServer, /https:\/\/api\.mausvoice\.com/);
    assert.match(source.newServer, /resolveNewServerUrl/);
  });
});
