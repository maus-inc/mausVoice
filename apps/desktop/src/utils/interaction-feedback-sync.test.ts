import { describe, expect, it, vi } from "vitest";
import {
  syncInteractionChime,
  syncInteractionFeedbackVolume,
} from "./interaction-feedback-sync";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("interaction feedback native synchronization", () => {
  it("waits for the earlier volume write before sending the latest value", async () => {
    let release!: () => void;
    const firstIpc = new Promise<void>((resolve) => {
      release = resolve;
    });
    invoke
      .mockReset()
      .mockReturnValueOnce(firstIpc)
      .mockResolvedValue(undefined);
    const first = syncInteractionFeedbackVolume(0.1);
    const second = syncInteractionFeedbackVolume(0.5);
    try {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke).toHaveBeenNthCalledWith(
        1,
        "set_interaction_feedback_volume",
        { volume: 0.1 },
      );
      release();
      await Promise.all([first, second]);
      expect(invoke).toHaveBeenNthCalledWith(
        2,
        "set_interaction_feedback_volume",
        { volume: 0.5 },
      );
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  });

  it("continues after a rejected chime write", async () => {
    invoke
      .mockReset()
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValue(undefined);
    const first = syncInteractionChime(false);
    const firstResult = expect(first).rejects.toThrow("bridge unavailable");
    const second = syncInteractionChime(true);
    await firstResult;
    await second;
    expect(invoke).toHaveBeenNthCalledWith(1, "set_interaction_chime_enabled", {
      enabled: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "set_interaction_chime_enabled", {
      enabled: true,
    });
  });
});
