import { describe, expect, it } from "vitest";

import {
  extractRustBlock,
  readRepoSource,
} from "../../test/helpers/rust-source.utils";

/**
 * Contract: the native listener strategy belongs to macOS, Windows and Linux
 * X11, and only a Wayland session runs the compositor bridge.
 *
 * The pill locate gesture is detected from the listener's stream of held keys,
 * so the settings row that offers it is shown exactly where that stream exists.
 * The rule behind the row reads `get_hotkey_strategy` from the renderer, and
 * nothing in this suite can call the Rust function, so the mapping is pinned
 * here at the source. A platform moved to the bridge, or a new platform added
 * without an answer, would otherwise let the row advertise a gesture nothing
 * can detect, and a reader would have no way to tell which platforms were
 * meant.
 *
 * Windows is on the listener side and has been since the platform module was
 * written. The bridge is Linux-only, and only while `detect::is_wayland()` says
 * the session is Wayland.
 */

/** A platform module that reports the listener strategy by re-exporting it. */
const LISTENER_REEXPORT =
  /pub use crate::platform::common::\{[^}]*listener_hotkey_strategy as get_hotkey_strategy/;

/** The Wayland decision, spelled out, with the listener as the other arm. */
const WAYLAND_ONLY_BRIDGE =
  /if detect::is_wayland\(\) \{\s*BRIDGE_HOTKEY_STRATEGY\s*\} else \{\s*LISTENER_HOTKEY_STRATEGY\s*\}/;

const platformModule = (platform: string): string =>
  readRepoSource(`apps/desktop/src-tauri/src/platform/${platform}/mod.rs`);

describe("hotkey strategy per platform", () => {
  it.each(["macos", "windows"])(
    "reports the listener strategy on %s",
    (platform) => {
      expect(platformModule(platform)).toMatch(LISTENER_REEXPORT);
    },
  );

  it("reports the bridge only for a Wayland session", () => {
    const strategy = extractRustBlock(
      platformModule("linux"),
      "pub fn get_hotkey_strategy()",
    );

    expect(strategy).toMatch(WAYLAND_ONLY_BRIDGE);
  });

  it("does not let the two strategy names drift apart", () => {
    const common = readRepoSource(
      "apps/desktop/src-tauri/src/platform/common.rs",
    );

    // `platform/linux` matches on these constants and the per-platform modules
    // return them, so the renderer's `"listener" | "bridge"` union is only
    // correct while these two literals are.
    expect(common).toContain(
      'pub const LISTENER_HOTKEY_STRATEGY: &str = "listener";',
    );
    expect(common).toContain(
      'pub const BRIDGE_HOTKEY_STRATEGY: &str = "bridge";',
    );
  });
});
