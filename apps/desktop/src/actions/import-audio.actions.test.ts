import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { createDefaultPreferences } from "./user.actions";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  transcribe: vi.fn(),
  postProcess: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ importAudioFile: mocks.pick }),
}));
vi.mock("./transcribe.actions", () => ({
  transcribeAudio: mocks.transcribe,
  postProcessTranscript: mocks.postProcess,
  storeTranscription: mocks.store,
}));

import { importAudioFile } from "./transcriptions.actions";

beforeEach(() => {
  vi.resetAllMocks();
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = createDefaultPreferences();
  state.local.ephemeralSessionActive = true;
  setAppState(state, true);
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

describe("importAudioFile", () => {
  it("leaves the pipeline untouched when the file picker is cancelled", async () => {
    mocks.pick.mockResolvedValue(null);
    expect(await importAudioFile({})).toBe(false);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("does not transcribe a file selected after the auth session changes", async () => {
    let select!: (value: { samples: number[]; sampleRate: number }) => void;
    mocks.pick.mockReturnValueOnce(
      new Promise((resolve) => {
        select = resolve;
      }),
    );
    mocks.transcribe.mockResolvedValue({
      rawTranscript: "old",
      sanitizedTranscript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.postProcess.mockResolvedValue({
      transcript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.store.mockResolvedValue({ transcription: null, wordCount: 1 });
    const pending = importAudioFile({});
    setAppState({ authSessionNonce: 1 });
    select({ samples: [0.1], sampleRate: 16000 });
    expect(await pending).toBe(false);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("does not post-process or store an old session's transcription", async () => {
    let finish!: (value: unknown) => void;
    mocks.pick.mockResolvedValue({ samples: [0.1], sampleRate: 16000 });
    mocks.transcribe.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.postProcess.mockResolvedValue({
      transcript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.store.mockResolvedValue({ transcription: null, wordCount: 1 });
    const pending = importAudioFile({});
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalled());
    setAppState({ authSessionNonce: 1 });
    finish({
      rawTranscript: "old",
      sanitizedTranscript: "old",
      warnings: [],
      metadata: {},
    });
    expect(await pending).toBe(false);
    expect(mocks.postProcess).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("does not store audio after post-processing finishes in a new session", async () => {
    let finish!: (value: unknown) => void;
    mocks.pick.mockResolvedValue({ samples: [0.1], sampleRate: 16000 });
    mocks.transcribe.mockResolvedValue({
      rawTranscript: "old",
      sanitizedTranscript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.postProcess.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = importAudioFile({});
    await vi.waitFor(() => expect(mocks.postProcess).toHaveBeenCalled());
    setAppState({ authSessionNonce: 1 });
    finish({ transcript: "old", warnings: [], metadata: {} });
    expect(await pending).toBe(false);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("does not report a retired picker's error to a successor", async () => {
    let fail!: (error: Error) => void;
    mocks.pick.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const pending = importAudioFile({});
    setAppState({ authSessionNonce: 1 });
    fail(new Error("old picker failed"));
    expect(await pending).toBe(false);
  });

  it("does not publish an old import after its store completes in a new session", async () => {
    let finish!: (value: unknown) => void;
    mocks.pick.mockResolvedValue({ samples: [0.1], sampleRate: 16000 });
    mocks.transcribe.mockResolvedValue({
      rawTranscript: "old",
      sanitizedTranscript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.postProcess.mockResolvedValue({
      transcript: "old",
      warnings: [],
      metadata: {},
    });
    mocks.store.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = importAudioFile({});
    await vi.waitFor(() => expect(mocks.store).toHaveBeenCalled());
    setAppState({ authSessionNonce: 1 });
    finish({ transcription: null, wordCount: 1 });
    expect(await pending).toBe(false);
    expect(Object.values(getAppState().transcriptionById)).toHaveLength(0);
  });

  it("keeps the full metadata in memory when persistence is disabled", async () => {
    mocks.pick.mockResolvedValue({ samples: [0.1], sampleRate: 16000 });
    mocks.transcribe.mockResolvedValue({
      rawTranscript: "raw",
      sanitizedTranscript: "raw",
      warnings: ["transcribe warning"],
      metadata: {
        modelSize: "tiny",
        inferenceDevice: "cpu",
        transcriptionDurationMs: 0,
      },
    });
    mocks.postProcess.mockResolvedValue({
      transcript: "Styled",
      warnings: ["style warning"],
      metadata: {
        postProcessModel: "model",
        postProcessFailed: false,
        postprocessDurationMs: 42,
      },
    });
    mocks.store.mockResolvedValue({ transcription: null, wordCount: 1 });

    expect(await importAudioFile({ languageCode: "en" })).toBe(true);
    expect(mocks.store).toHaveBeenCalledOnce();
    const records = Object.values(getAppState().transcriptionById);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      transcript: "Styled",
      rawTranscript: "raw",
      modelSize: "tiny",
      inferenceDevice: "cpu",
      transcriptionDurationMs: 0,
      postProcessModel: "model",
      postProcessFailed: false,
      postprocessDurationMs: 42,
      warnings: ["transcribe warning", "style warning"],
      transcriptionApiKeyId: null,
      postProcessApiKeyId: null,
      remoteDeviceId: null,
    });
  });
});
