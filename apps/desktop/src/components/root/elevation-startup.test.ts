/**
 * Elevation pre-flight gate contracts, expressed as exported API / state
 * transitions rather than source-string matching.
 */
import { describe, expect, it } from "vitest";
import {
  canRunPostElevationInit,
  isElevationStartupReady,
  isReadyForFullApp,
} from "../../actions/elevation.actions";
import { INITIAL_SETTINGS_STATE } from "../../state/settings.state";

describe("elevation startup gate", () => {
  it("defaults elevationStartupPending so first paint cannot race full init", () => {
    expect(INITIAL_SETTINGS_STATE.elevationStartupPending).toBe(true);
    expect(INITIAL_SETTINGS_STATE.elevationDeclinedDialogOpen).toBe(false);
  });

  it("holds the router and heavy side-effects behind the elevation gate", () => {
    expect(isElevationStartupReady(true)).toBe(false);
    expect(canRunPostElevationInit(false)).toBe(false);
    expect(isReadyForFullApp(true, false)).toBe(false);

    expect(isElevationStartupReady(false)).toBe(true);
    expect(canRunPostElevationInit(true)).toBe(true);
    expect(isReadyForFullApp(true, true)).toBe(true);
  });

  // Platform and relaunch-result policy cases live in elevation.actions.test.ts.
});
