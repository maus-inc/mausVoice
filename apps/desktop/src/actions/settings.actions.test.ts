import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { openPostProcessingSettings } from "./settings.actions";

describe("openPostProcessingSettings", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("opens the AI post-processing dialog", () => {
    expect(getAppState().settings.aiPostProcessingDialogOpen).toBe(false);

    openPostProcessingSettings();

    expect(getAppState().settings.aiPostProcessingDialogOpen).toBe(true);
  });
});
