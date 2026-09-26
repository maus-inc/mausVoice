import type { ApiKey } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
} from "../utils/personal-use.utils";

const { apiKeyActionsMock, userActionsMock, loggerMock } = vi.hoisted(() => ({
  apiKeyActionsMock: {
    createApiKey: vi.fn(),
    updateApiKey: vi.fn(),
    loadApiKeys: vi.fn(),
  },
  userActionsMock: {
    updateUserPreferences: vi.fn(),
  },
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

vi.mock("./api-key.actions", () => apiKeyActionsMock);
vi.mock("./user.actions", () => userActionsMock);
vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

const { savePersonalDeepgramApiKey, configurePersonalDefaults } =
  await import("./personal-use.actions");

const deepgramKey = (overrides: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: PERSONAL_DEEPGRAM_API_KEY_ID,
    name: "Personal Deepgram",
    provider: "deepgram",
    key: "dg-existin...",
    keyFull: "dg-existing",
    transcriptionModel: null,
    ...overrides,
  }) as ApiKey;

const setApiKeys = (apiKeys: ApiKey[]) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.apiKeys = apiKeys;
  setAppState(state, true);
};

beforeEach(() => {
  vi.clearAllMocks();
  setApiKeys([]);
  // Mirrors the real updateApiKey, which writes the patched row back into the
  // store. Without that write-back these tests could not detect a repeated
  // call re-issuing the same update on every app start.
  apiKeyActionsMock.updateApiKey.mockImplementation(
    async (payload: { id: string; transcriptionModel?: string }) => {
      const state = getAppState();
      const index = state.settings.apiKeys.findIndex(
        (k) => k.id === payload.id,
      );
      const current =
        index === -1 ? deepgramKey() : state.settings.apiKeys[index];
      const updated = { ...current, ...payload } as ApiKey;
      if (index !== -1) {
        const next = structuredClone(INITIAL_APP_STATE);
        next.settings.apiKeys = [...state.settings.apiKeys];
        next.settings.apiKeys[index] = updated;
        setAppState(next, true);
      }
      return updated;
    },
  );
  apiKeyActionsMock.createApiKey.mockImplementation(async () => deepgramKey());
});

describe("savePersonalDeepgramApiKey", () => {
  it("presets the transcription model when the key is created", async () => {
    await savePersonalDeepgramApiKey("dg-new");

    expect(apiKeyActionsMock.createApiKey).toHaveBeenCalledTimes(1);
    expect(apiKeyActionsMock.updateApiKey).toHaveBeenCalledWith({
      id: PERSONAL_DEEPGRAM_API_KEY_ID,
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  });

  it("backfills the model on a key that predates the preset", async () => {
    setApiKeys([deepgramKey()]);

    await savePersonalDeepgramApiKey("dg-existing");

    expect(apiKeyActionsMock.updateApiKey).toHaveBeenCalledWith({
      id: PERSONAL_DEEPGRAM_API_KEY_ID,
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  });

  it("leaves a model the user chose alone", async () => {
    setApiKeys([deepgramKey({ transcriptionModel: "nova-2" })]);

    await savePersonalDeepgramApiKey("dg-existing");

    expect(apiKeyActionsMock.updateApiKey).not.toHaveBeenCalled();
  });

  it("does not rewrite an unchanged key", async () => {
    setApiKeys([
      deepgramKey({
        transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
      }),
    ]);

    await savePersonalDeepgramApiKey("dg-existing");

    expect(apiKeyActionsMock.updateApiKey).not.toHaveBeenCalled();
  });

  it("applies the transcription selection after saving", async () => {
    await savePersonalDeepgramApiKey("dg-new");

    // updateUserPreferences takes a mutator, so assert it was reached and let
    // resolvePersonalTranscriptionTarget's own tests cover the decision.
    expect(userActionsMock.updateUserPreferences).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });
});

describe("configurePersonalDefaults", () => {
  it("backfills the model for an install that already has the key", async () => {
    setApiKeys([deepgramKey()]);

    await configurePersonalDefaults();

    expect(apiKeyActionsMock.updateApiKey).toHaveBeenCalledWith({
      id: PERSONAL_DEEPGRAM_API_KEY_ID,
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  });

  it("does not touch a key that already has a model", async () => {
    setApiKeys([
      deepgramKey({
        transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
      }),
    ]);

    await configurePersonalDefaults();

    expect(apiKeyActionsMock.updateApiKey).not.toHaveBeenCalled();
  });

  it("does nothing when no personal key exists", async () => {
    await configurePersonalDefaults();

    expect(apiKeyActionsMock.updateApiKey).not.toHaveBeenCalled();
  });

  // getPersonalDeepgramApiKey also adopts a row matched on provider and name,
  // so its id is not necessarily the personal-deepgram constant. The update
  // must carry the row's real id: update_api_key matches on id, so a hardcoded
  // constant would update zero rows and throw on every app start, because this
  // function runs from RootSideEffects on every launch.
  it("updates the adopted key by its own id, not the default id", async () => {
    setApiKeys([deepgramKey({ id: "adopted-7f3a" })]);

    await configurePersonalDefaults();

    expect(apiKeyActionsMock.updateApiKey).toHaveBeenCalledWith({
      id: "adopted-7f3a",
      transcriptionModel: PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    });
  });

  // configurePersonalDefaults runs from RootSideEffects on every app start, so
  // a second run must not repeat the write.
  it("writes once across repeated starts, leaving the store holding the model", async () => {
    setApiKeys([deepgramKey()]);

    await configurePersonalDefaults();
    expect(apiKeyActionsMock.updateApiKey).toHaveBeenCalledTimes(1);

    apiKeyActionsMock.updateApiKey.mockClear();
    await configurePersonalDefaults();

    expect(apiKeyActionsMock.updateApiKey).not.toHaveBeenCalled();
    expect(getAppState().settings.apiKeys[0].transcriptionModel).toBe(
      PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    );
  });
});
