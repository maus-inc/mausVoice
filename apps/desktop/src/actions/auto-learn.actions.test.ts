import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { createDefaultPreferences } from "./user.actions";

const { updateTranscription, createGlossaryTerms, getMyUserPreferences } =
  vi.hoisted(() => ({
    updateTranscription: vi.fn(),
    createGlossaryTerms: vi.fn(),
    getMyUserPreferences: vi.fn(),
  }));

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ updateTranscription }),
}));

vi.mock("./dictionary.actions", () => ({ createGlossaryTerms }));

vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  getMyUserPreferences,
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => loggerMock,
}));

const { intlFormatMessage } = vi.hoisted(() => ({
  /** Every descriptor the code under test asked the intl layer to format. */
  intlFormatMessage: vi.fn(),
}));

// Wrapped, never stubbed. `getIntl` passes an id-less descriptor through as its
// `defaultMessage`, so the string the action throws is identical whether it was
// routed through intl or written inline; only the recorded descriptors can tell
// the two apart.
vi.mock("../i18n/intl", async () => {
  const actual =
    await vi.importActual<typeof import("../i18n/intl")>("../i18n/intl");
  return {
    ...actual,
    getIntl: (...args: Parameters<typeof actual.getIntl>) => {
      const intl = actual.getIntl(...args);
      const realFormatMessage = intl.formatMessage;
      return {
        ...intl,
        formatMessage: (...format: Parameters<IntlShape["formatMessage"]>) => {
          intlFormatMessage(format[0]);
          return realFormatMessage(...format);
        },
      };
    },
  };
});

const { saveCorrectedTranscript } = await import("./auto-learn.actions");

/** The Error a call rejected with, so an assertion can read `error.message`. */
const rejectionOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
};

const sampleTranscription = (id: string): Transcription =>
  ({
    id,
    audioDataId: "audio",
    transcript: "my wife's name is Sonia",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  }) as unknown as Transcription;

const seed = ({
  incognito = false,
  ephemeral = false,
}: { incognito?: boolean; ephemeral?: boolean } = {}) => {
  const state = structuredClone(INITIAL_APP_STATE);
  const prefs = createDefaultPreferences();
  prefs.incognitoModeEnabled = incognito;
  prefs.autoLearnDictionaryEnabled = false;
  state.userPrefs = prefs;
  state.local.ephemeralSessionActive = ephemeral;
  state.transcriptionById["tx"] = sampleTranscription("tx");
  setAppState(state, true);
};

beforeEach(() => {
  vi.clearAllMocks();
  updateTranscription.mockImplementation((payload: Transcription) =>
    Promise.resolve(payload),
  );
  createGlossaryTerms.mockResolvedValue({ created: [], failed: 0 });
  getMyUserPreferences.mockReturnValue({ autoLearnDictionaryEnabled: false });
});

afterEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("saveCorrectedTranscript persistence gate", () => {
  it("persists the correction when persistence is allowed", async () => {
    seed();

    await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: "my wife's name is Soniya",
    });

    expect(updateTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tx",
        transcript: "my wife's name is Soniya",
      }),
    );
    expect(getAppState().transcriptionById["tx"]?.transcript).toBe(
      "my wife's name is Soniya",
    );
  });

  it.each([
    ["incognito mode", { incognito: true }],
    ["an ephemeral session", { ephemeral: true }],
  ])("keeps the correction in memory only during %s", async (_label, mode) => {
    // The privacy modes promise nothing about the session's transcripts is
    // written out, and editing a row is a write like any other.
    seed(mode);

    await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: "my wife's name is Soniya",
    });

    expect(updateTranscription).not.toHaveBeenCalled();
    expect(getAppState().transcriptionById["tx"]?.transcript).toBe(
      "my wife's name is Soniya",
    );
  });

  it("restores the previous text when the write fails", async () => {
    seed();
    updateTranscription.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      saveCorrectedTranscript({
        transcriptionId: "tx",
        correctedText: "my wife's name is Soniya",
      }),
    ).rejects.toThrow("write failed");

    expect(getAppState().transcriptionById["tx"]?.transcript).toBe(
      "my wife's name is Sonia",
    );
  });
});

describe("saveCorrectedTranscript glossary gate", () => {
  // The glossary is a second write, not a consequence of the first. Learned
  // terms are proper nouns lifted verbatim out of the corrected text, so a
  // transcript row that stayed in memory while its nouns went to the dictionary
  // would leave the sensitive content behind anyway.
  const learnable = "my wife's name is Soniya";

  it.each([
    ["incognito mode", { incognito: true }],
    ["an ephemeral session", { ephemeral: true }],
  ])("writes no glossary terms during %s", async (_label, mode) => {
    seed(mode);
    getMyUserPreferences.mockReturnValue({ autoLearnDictionaryEnabled: true });

    const result = await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: learnable,
    });

    expect(createGlossaryTerms).not.toHaveBeenCalled();
    expect(result.learnedTerms).toEqual([]);
    expect(result.failedTerms).toBe(0);
    // Not just an empty list. Without this the caller cannot tell "the
    // correction taught nothing" from "the mode refused the write", and the
    // toast reports a promise the code does not keep.
    expect(result.dictionarySuppressed).toBe(true);
  });

  // The positive control. Without it the pair above would also pass if
  // auto-learning never ran for this correction at all, which is the shape a
  // test-only fix takes.
  it("writes the glossary terms when persistence is allowed", async () => {
    seed();
    getMyUserPreferences.mockReturnValue({ autoLearnDictionaryEnabled: true });
    createGlossaryTerms.mockResolvedValue({
      created: [{ sourceValue: "Soniya" }],
      failed: 0,
    });

    const result = await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: learnable,
    });

    expect(createGlossaryTerms).toHaveBeenCalledWith(["Soniya"]);
    expect(result.learnedTerms).toEqual(["Soniya"]);
    expect(result.dictionarySuppressed).toBe(false);
  });

  it("does not claim a suppression when auto-learn was never wanted", async () => {
    // The flag describes a refused write, not a disabled feature. Reporting it
    // for an auto-learn-off user would put an Incognito explanation on a
    // correction that had nothing to learn anyway.
    seed({ incognito: true });
    getMyUserPreferences.mockReturnValue({ autoLearnDictionaryEnabled: false });

    const result = await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: learnable,
    });

    expect(result.dictionarySuppressed).toBe(false);
  });

  it("still honours auto-learn being switched off", async () => {
    // Guard against the gate being implemented by disabling the feature rather
    // than by refusing the write.
    seed();
    getMyUserPreferences.mockReturnValue({ autoLearnDictionaryEnabled: false });

    await saveCorrectedTranscript({
      transcriptionId: "tx",
      correctedText: learnable,
    });

    expect(updateTranscription).toHaveBeenCalled();
    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });
});

describe("saveCorrectedTranscript error copy", () => {
  it("reports an unknown transcription through the intl layer", async () => {
    // `TranscriptionDetailsDialog` hands a thrown Error straight to the error
    // snackbar, which stringifies it.
    seed();

    const error = await rejectionOf(
      saveCorrectedTranscript({
        transcriptionId: "missing",
        correctedText: "anything",
      }),
    );

    expect(error.message).toBe("Transcription not found.");
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMessage: "Transcription not found." }),
    );
    expect(updateTranscription).not.toHaveBeenCalled();
  });

  it("reports an empty correction through the intl layer", async () => {
    seed();

    const error = await rejectionOf(
      saveCorrectedTranscript({
        transcriptionId: "tx",
        correctedText: "   ",
      }),
    );

    expect(error.message).toBe("Transcript cannot be empty.");
    expect(intlFormatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultMessage: "Transcript cannot be empty.",
      }),
    );
    expect(updateTranscription).not.toHaveBeenCalled();
  });
});
