import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  openPostProcessingSettings,
  openTranscriptionsHistory,
} from "./settings.actions";
import { registerAppNavigation } from "../utils/app-navigation";

const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: warningMock }),
}));

describe("openTranscriptionsHistory", () => {
  it("uses the registered router without constructing it eagerly", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    registerAppNavigation(navigate);
    expect(navigate).not.toHaveBeenCalled();
    openTranscriptionsHistory();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/dashboard/transcriptions"),
    );
  });

  it("contains synchronous and asynchronous navigation failures", async () => {
    const navigate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("init failed");
      })
      .mockRejectedValueOnce(new Error("navigation failed"));
    registerAppNavigation(navigate);
    openTranscriptionsHistory();
    openTranscriptionsHistory();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warningMock).toHaveBeenCalledTimes(2));
    expect(warningMock).toHaveBeenCalledWith(
      "Failed to open transcription history: init failed",
    );
    expect(warningMock).toHaveBeenCalledWith(
      "Failed to open transcription history: navigation failed",
    );
  });
});

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
