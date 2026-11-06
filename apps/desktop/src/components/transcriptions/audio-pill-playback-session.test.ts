import { beforeEach, describe, expect, it, vi } from "vitest";

const { stopActivePlaybackMock } = vi.hoisted(() => ({
  stopActivePlaybackMock: vi.fn(),
}));

vi.mock("../../utils/audio-playback.utils", () => ({
  stopActivePlayback: stopActivePlaybackMock,
}));

import { createAudioPillPlaybackSession } from "./audio-pill-playback-session";

describe("createAudioPillPlaybackSession", () => {
  beforeEach(() => {
    stopActivePlaybackMock.mockReset();
  });

  it("transfers global ownership when another pill starts a request", () => {
    const first = createAudioPillPlaybackSession();
    const second = createAudioPillPlaybackSession();

    const attemptA = first.beginRequest();
    expect(attemptA.isCurrent()).toBe(true);
    expect(stopActivePlaybackMock).toHaveBeenLastCalledWith("replaced");

    const attemptB = second.beginRequest();
    expect(attemptA.isCurrent()).toBe(false);
    expect(attemptB.isCurrent()).toBe(true);

    // Stopping the superseded session does not stop the new owner's audio.
    stopActivePlaybackMock.mockClear();
    expect(first.stopOwned()).toBe(false);
    expect(stopActivePlaybackMock).not.toHaveBeenCalled();

    expect(second.stopOwned()).toBe(true);
    expect(stopActivePlaybackMock).toHaveBeenCalledWith("stopped");
  });

  it("retains ownership across setup-stop callback until releaseOnError runs", () => {
    const session = createAudioPillPlaybackSession();
    const attempt = session.beginRequest();

    attempt.beginSetup();
    expect(attempt.handleStopCallback("stopped")).toBe(true);
    expect(attempt.isCurrent()).toBe(true);
    expect(attempt.releaseOnError()).toBe(true);
    expect(attempt.isCurrent()).toBe(false);
  });
});
