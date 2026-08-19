/**
 * Contract tests for the elevation pre-flight gate timing.
 *
 * The gate must resolve from a minimal prefs read BEFORE auth / full init.
 * These tests pin the AppSideEffects source shape and the settings flag
 * defaults so a regression cannot silently move UAC after dashboard load.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INITIAL_SETTINGS_STATE } from "../../state/settings.state";

const sideEffectsSource = readFileSync(
  new URL("./AppSideEffects.tsx", import.meta.url),
  "utf8",
);
const appWithLoadingSource = readFileSync(
  new URL("./AppWithLoading.tsx", import.meta.url),
  "utf8",
);

describe("elevation startup gate", () => {
  it("defaults elevationStartupPending so first paint cannot race full init", () => {
    expect(INITIAL_SETTINGS_STATE.elevationStartupPending).toBe(true);
    expect(INITIAL_SETTINGS_STATE.elevationDeclinedDialogOpen).toBe(false);
  });

  it("holds the router and heavy side-effects behind elevationStartupPending", () => {
    expect(appWithLoadingSource).toContain("elevationStartupPending");
    expect(appWithLoadingSource).toContain("ElevationDeclinedDialog");
    // Heavy subsystems must not mount while the gate is pending.
    expect(appWithLoadingSource).toMatch(
      /!elevationStartupPending && \([\s\S]*DictationSideEffects/,
    );
    expect(appWithLoadingSource).toMatch(
      /readyForApp \? <Router \/> : <LoadingApp \/>/,
    );
  });

  it("starts elevation from a direct prefs read before auth listeners attach", () => {
    const elevationBlockStart = sideEffectsSource.indexOf(
      'Windows "Always run as administrator" pre-flight',
    );
    const authBlockStart = sideEffectsSource.indexOf(
      "Auth and the rest of full-app init stay behind the elevation gate",
    );
    expect(elevationBlockStart).toBeGreaterThanOrEqual(0);
    expect(authBlockStart).toBeGreaterThan(elevationBlockStart);

    // Auth subscription is gated.
    expect(sideEffectsSource).toMatch(
      /if \(elevationStartupPending\) \{\s*return;\s*\}[\s\S]*getAuthRepo\(\)\.onAuthStateChanged/,
    );
  });

  it("only releases the gate on cancel via the decline dialog, not the action", () => {
    // requestAdminRelaunch on cancel / require-restart must NOT clear
    // elevationStartupPending inside AppSideEffects — Launch normally does
    // that in the dialog; require-restart keeps the gate until process exit.
    const gateHoldStart = sideEffectsSource.indexOf(
      'if (result === "cancelled" || result === "require-restart")',
    );
    expect(gateHoldStart).toBeGreaterThanOrEqual(0);
    const cancelBranch = sideEffectsSource.slice(
      gateHoldStart,
      sideEffectsSource.indexOf("success (already elevated", gateHoldStart),
    );
    expect(cancelBranch).toContain("return;");
    expect(cancelBranch).not.toContain("releaseElevationGate");
  });
});
