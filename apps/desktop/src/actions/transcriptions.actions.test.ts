import type { Transcription } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { retranscribeTranscription } from "./transcriptions.actions";
import { createDefaultPreferences } from "./user.actions";

const { repoMock, transcribeAudioMock, postProcessTranscriptMock } = vi.hoisted(
  () => ({
    repoMock: {
      loadTranscriptionAudio: vi.fn(),
      updateTranscription: vi.fn(),
    },
    transcribeAudioMock: vi.fn(),
    postProcessTranscriptMock: vi.fn(),
  }),
);

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => repoMock,
}));

vi.mock("./transcribe.actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcribe.actions")>();
  return {
    ...actual,
    transcribeAudio: transcribeAudioMock,
    postProcessTranscript: postProcessTranscriptMock,
  };
});

const seedTranscription = (): Transcription => ({
  id: "tx-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "original text",
  isDeleted: false,
});

const applyState = (ephemeralSessionActive = false) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = createDefaultPreferences();
  state.local.ephemeralSessionActive = ephemeralSessionActive;
  state.transcriptionById["tx-1"] = seedTranscription();
  setAppState(state, true);
};

describe("retranscribeTranscription persistence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMock.loadTranscriptionAudio.mockResolvedValue({
      samples: [0.1, 0.2],
      sampleRate: 16000,
    });
    repoMock.updateTranscription.mockImplementation(
      async (payload: Transcription) => payload,
    );
    transcribeAudioMock.mockResolvedValue({
      rawTranscript: "raw retranscribed",
      warnings: [],
      metadata: {},
    });
    postProcessTranscriptMock.mockResolvedValue({
      transcript: "retranscribed text",
      warnings: [],
    });
  });

  afterEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("persists the retranscribed payload when persistence is allowed", async () => {
    applyState(false);

    await retranscribeTranscription({ transcriptionId: "tx-1" });

    expect(repoMock.updateTranscription).toHaveBeenCalledTimes(1);
    expect(repoMock.updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tx-1", transcript: "retranscribed text" }),
    );
    expect(getAppState().transcriptionById["tx-1"]?.transcript).toBe(
      "retranscribed text",
    );
  });

  it("updates memory only and skips the repo write during an ephemeral session", async () => {
    applyState(true);

    await retranscribeTranscription({ transcriptionId: "tx-1" });

    expect(repoMock.updateTranscription).not.toHaveBeenCalled();
    expect(getAppState().transcriptionById["tx-1"]?.transcript).toBe(
      "retranscribed text",
    );
  });
});
