import type { UserPreferences } from "@maus-inc/types";
import { describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { selectSettingsPageSnapshot } from "./settings-page-snapshot";

const stateWithPrefs = (prefs: Record<string, unknown> | null) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = prefs as UserPreferences | null;
  return state;
};

describe("selectSettingsPageSnapshot", () => {
  it.each([
    null,
    {},
    {
      preserveAudioOnFailure: null,
      autoLearnDictionaryEnabled: null,
      hallucinationFilterEnabled: null,
      spokenCommandsEnabled: null,
      reviewBeforeInsert: null,
    },
  ])("uses safe defaults for absent or legacy preferences", (prefs) => {
    const snapshot = selectSettingsPageSnapshot(stateWithPrefs(prefs));
    expect(snapshot.slice(0, 7)).toEqual([
      false,
      false,
      false,
      true,
      "persistent",
      "current",
      false,
    ]);
    expect(snapshot.slice(15, 22)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("preserves explicitly selected false and true values", () => {
    const snapshot = selectSettingsPageSnapshot(
      stateWithPrefs({
        ignoreUpdateDialog: true,
        incognitoModeEnabled: true,
        incognitoModeIncludeInStats: true,
        preserveAudioOnFailure: false,
        dictationPillVisibility: "hidden",
        pillResetMonitorStrategy: "cursor",
        realtimeOutputEnabled: true,
        autoLearnDictionaryEnabled: false,
        autoLearnFromEditsEnabled: true,
        elevenLabsKeytermsEnabled: true,
        spokenCommandsEnabled: false,
        reviewBeforeInsert: true,
        hallucinationFilterEnabled: false,
        inDictationStyleSwitchingEnabled: true,
      }),
    );
    expect(snapshot.slice(0, 7)).toEqual([
      true,
      true,
      true,
      false,
      "hidden",
      "cursor",
      true,
    ]);
    expect(snapshot.slice(15, 22)).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });
});
