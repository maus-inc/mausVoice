import { describe, expect, it, vi } from "vitest";
import type { AppTarget } from "@maus-inc/types";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  track: vi.fn(),
  state: {} as object,
  stylingMode: vi.fn(() => "manual"),
  selectedTone: vi.fn(() => "live"),
  resolveTone: vi.fn(() => "resolved-tone"),
  logger: { verbose: vi.fn(), warning: vi.fn() },
}));
vi.mock("../../actions/app-target.actions", () => ({
  saveManualStyleForApp: mocks.save,
}));
vi.mock("../../utils/analytics.utils", () => ({ trackAppUsed: mocks.track }));
vi.mock("../../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../../utils/feature.utils", () => ({
  getEffectiveStylingMode: mocks.stylingMode,
}));
vi.mock("../../utils/tone.utils", () => ({
  getManuallySelectedToneId: mocks.selectedTone,
}));
vi.mock("../../utils/dictation-style.utils", () => ({
  getEffectiveToneIdAtFinalize: mocks.resolveTone,
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import {
  prepareFinalizationContext,
  logFinalizationSummary,
} from "./dictation-finalize-context";

describe("finalization context", () => {
  it("captures the stop style before awaiting the app style save", async () => {
    vi.clearAllMocks();
    let finish!: () => void;
    let saveStarted!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    mocks.save.mockImplementation(() => {
      saveStarted();
      return pending;
    });
    const target = { name: "Editor", toneId: "app-tone" } as AppTarget;
    const snapshots = vi.fn(() => ({ start: "start-tone", stop: "stop-tone" }));
    const result = prepareFinalizationContext(
      Promise.resolve({ appTarget: target, a11yInfo: null }),
      snapshots,
    );
    await started;
    expect(snapshots).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ toneId: "stop-tone" }),
    );
    finish();
    expect(await result).toEqual({
      appTarget: target,
      a11yInfo: null,
      toneId: "resolved-tone",
    });
    expect(mocks.track).toHaveBeenCalledWith("Editor");
    expect(mocks.resolveTone).toHaveBeenCalledWith({
      stylingMode: "manual",
      toneIdAtStart: "start-tone",
      toneIdAtStop: "stop-tone",
      liveSelectedToneId: "live",
      appTargetToneId: "app-tone",
    });
  });
  it("logs transcript length without exposing dictated text", () => {
    vi.clearAllMocks();
    logFinalizationSummary("secret words", null, null);
    const message = mocks.logger.verbose.mock.calls[0][0];
    expect(message).toContain("12 chars");
    expect(message).not.toContain("secret words");
    expect(message).toContain("app=unknown");
  });
  it("uses the unknown-app fallback without saving an absent target", async () => {
    vi.clearAllMocks();
    const result = await prepareFinalizationContext(
      Promise.resolve({ appTarget: null, a11yInfo: null }),
      () => ({ start: null, stop: null }),
    );
    expect(mocks.track).toHaveBeenCalledWith("Unknown");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(result.toneId).toBe("resolved-tone");
    expect(mocks.resolveTone).toHaveBeenCalledWith(
      expect.objectContaining({ appTargetToneId: null }),
    );
  });
  it("continues with the stop snapshot when style persistence fails", async () => {
    vi.clearAllMocks();
    mocks.save.mockRejectedValueOnce(new Error("private save detail"));
    const read = vi.fn(() => ({ start: "start", stop: "stop" }));
    const result = await prepareFinalizationContext(
      Promise.resolve({
        appTarget: { name: "Editor" } as AppTarget,
        a11yInfo: null,
      }),
      read,
    );
    expect(result.toneId).toBe("resolved-tone");
    expect(read).toHaveBeenCalledOnce();
    expect(mocks.logger.warning).toHaveBeenCalledWith(
      "Could not finish saving the application style",
    );
    expect(JSON.stringify(mocks.logger.warning.mock.calls)).not.toContain(
      "private save detail",
    );
  });

  it("does not let a hung style write strand the stopped recording", async () => {
    vi.useFakeTimers();
    try {
      mocks.save.mockReturnValueOnce(new Promise(() => {}));
      const result = prepareFinalizationContext(
        Promise.resolve({
          appTarget: { name: "Editor" } as AppTarget,
          a11yInfo: null,
        }),
        () => ({ start: "start", stop: "stop" }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toMatchObject({ toneId: "resolved-tone" });
      const options = mocks.save.mock.calls.at(-1)?.[1] as {
        isCurrent: () => boolean;
      };
      expect(options.isCurrent()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
