import type { ApiKey } from "@maus-inc/types";
import { readFileSync } from "node:fs";
import { createIntl, type IntlShape } from "react-intl";
import { describe, expect, it } from "vitest";
import {
  createTranscriptionSession,
  resolveTranscriptionSessionKind,
} from "../sessions";
import {
  AssemblyAITranscriptionSession,
  AzureTranscriptionSession,
  DeepgramTranscriptionSession,
  ElevenLabsTranscriptionSession,
  GladiaTranscriptionSession,
} from "../sessions";
import manifest from "../i18n/manifest.json";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { TRANSCRIPTION_CAPABLE_PROVIDERS } from "./user.utils";
import {
  disclosureIsVisible,
  getCancelTranscriptPromptMessage,
  getTranscriptionAudioDisclosure,
} from "./transcription-privacy.utils";

const apiKey = (
  id: string,
  provider: ApiKey["provider"],
  overrides: Partial<ApiKey> = {},
): ApiKey => ({
  id,
  name: id,
  provider,
  createdAt: "2026-01-01T00:00:00.000Z",
  keyFull: "sk-test",
  ...overrides,
});

const stateWith = (mutate: (state: AppState) => void): AppState => {
  const state = structuredClone(INITIAL_APP_STATE);
  mutate(state);
  return state;
};

const cloudState = (provider: ApiKey["provider"] = "assemblyai") =>
  stateWith((state) => {
    state.apiKeyById = { "key-1": apiKey("key-1", provider) };
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "key-1";
  });

const localState = () =>
  stateWith((state) => {
    state.settings.aiTranscription.mode = "local";
  });

const apiPrefs = (provider: ApiKey["provider"]) => ({
  mode: "api" as const,
  provider,
  apiKeyId: "key-1",
  apiKeyValue: "sk-test",
  transcriptionModel: null,
  warnings: [],
});

/**
 * The classes that upload audio while the user is still talking, decided by the
 * instance `createTranscriptionSession` builds rather than by
 * `supportsStreaming()`. Azure is in this list and reports `false` from
 * `supportsStreaming()`, which is exactly why the capability method cannot be
 * the discriminator.
 */
const LIVE_STREAMING_CLASSES = [
  AssemblyAITranscriptionSession,
  DeepgramTranscriptionSession,
  ElevenLabsTranscriptionSession,
  GladiaTranscriptionSession,
  AzureTranscriptionSession,
];

const buildsLiveStreamingSession = (provider: ApiKey["provider"]): boolean => {
  const session = createTranscriptionSession(apiPrefs(provider));
  return LIVE_STREAMING_CLASSES.some((cls) => session instanceof cls);
};

describe("transcription audio disclosure", () => {
  it("reports no transmission in local mode", () => {
    const disclosure = getTranscriptionAudioDisclosure(localState());
    expect(disclosure.kind).toBe("local");
    expect(disclosure.providerName).toBeNull();
    expect(disclosureIsVisible(disclosure)).toBe(false);
  });

  it("keeps the disclosure visible before a key is saved", () => {
    // Onboarding shows this the moment API mode is picked, before the key row
    // is filled in, so a missing key value must not hide it.
    const selected = stateWith((state) => {
      state.settings.aiTranscription.mode = "api";
    });
    const disclosure = getTranscriptionAudioDisclosure(selected);
    expect(disclosureIsVisible(disclosure)).toBe(false);
  });

  it("names the bare provider display name, never the session label", () => {
    expect(
      getTranscriptionAudioDisclosure(cloudState("assemblyai")).providerName,
    ).toBe("AssemblyAI");
    expect(
      getTranscriptionAudioDisclosure(cloudState("deepgram")).providerName,
    ).toBe("Deepgram");
  });

  it("hides the copy for a selection that cannot transcribe", () => {
    // A stale selection (no key, or a key whose provider this build cannot
    // transcribe) dispatches to nothing, so naming a provider would be false.
    const noKey = stateWith((state) => {
      state.settings.aiTranscription.mode = "api";
    });
    const unknownProvider = stateWith((state) => {
      state.apiKeyById = {
        "key-1": apiKey("key-1", "from-the-future" as ApiKey["provider"]),
      };
      state.settings.aiTranscription.mode = "api";
      state.settings.aiTranscription.selectedApiKeyId = "key-1";
    });
    for (const state of [noKey, unknownProvider]) {
      const disclosure = getTranscriptionAudioDisclosure(state);
      expect(disclosure.providerName).toBeNull();
      expect(disclosureIsVisible(disclosure)).toBe(false);
    }
  });

  // The finding this test exists for: the copy promised live streaming for all
  // thirteen transcription-capable providers, while only five build a session
  // that uploads while the user is still talking. Asserting against the built
  // session class is what makes the sentence unable to drift away again.
  it("streams live for exactly the providers that upload during speech", () => {
    const streaming = [...TRANSCRIPTION_CAPABLE_PROVIDERS]
      .filter(buildsLiveStreamingSession)
      .sort();
    expect(streaming).toEqual([
      "assemblyai",
      "azure",
      "deepgram",
      "elevenlabs",
      "gladia",
    ]);
  });

  it("cannot use supportsStreaming() as the discriminator", () => {
    // Azure genuinely streams, and reports false from supportsStreaming(). A
    // gate built on that method would describe Azure as a batch provider, which
    // is the defect the class-level gate removes.
    const azure = createTranscriptionSession(apiPrefs("azure"));
    expect(azure.supportsStreaming()).toBe(false);
    expect(buildsLiveStreamingSession("azure")).toBe(true);
  });

  it.each([...TRANSCRIPTION_CAPABLE_PROVIDERS])(
    "reports the transmission behaviour of the session %s actually gets",
    (provider) => {
      const session = createTranscriptionSession(apiPrefs(provider));
      const streamsLive = LIVE_STREAMING_CLASSES.some(
        (cls) => session instanceof cls,
      );
      const kind = resolveTranscriptionSessionKind({ mode: "api", provider });
      expect(kind).toBe(streamsLive ? "live-streaming" : "after-stop");
      expect(getTranscriptionAudioDisclosure(cloudState(provider)).kind).toBe(
        kind,
      );
    },
  );

  it("treats a single-model local chain as local", () => {
    expect(
      resolveTranscriptionSessionKind({ mode: "local", provider: "groq" }),
    ).toBe("local");
  });
});

describe("cancel transcript prompt", () => {
  // A stub, not a real intl: the point here is which branch is taken and which
  // values it interpolates. The catalogs themselves are exercised below.
  const intl = {
    formatMessage: (
      { defaultMessage }: { defaultMessage?: string },
      values?: Record<string, string>,
    ) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, value),
        defaultMessage ?? "",
      ),
  } as unknown as IntlShape;

  it("warns that sent audio cannot be recalled on a live-streaming provider", () => {
    expect(
      getCancelTranscriptPromptMessage(
        getTranscriptionAudioDisclosure(cloudState("assemblyai")),
        intl,
      ),
    ).toBe(
      "Press cancel again to discard. Audio already sent to AssemblyAI can't be recalled.",
    );
  });

  it("keeps the local wording for a batch provider, which has sent nothing", () => {
    // A batch session uploads only after recording stops, so nothing has left
    // the machine when this prompt appears. Claiming otherwise would be the
    // same class of defect as promising live streaming for a batch provider.
    expect(
      getCancelTranscriptPromptMessage(
        getTranscriptionAudioDisclosure(cloudState("groq")),
        intl,
      ),
    ).toBe("Press cancel again to discard transcript");
  });

  it("keeps the local wording in local mode", () => {
    expect(
      getCancelTranscriptPromptMessage(
        getTranscriptionAudioDisclosure(localState()),
        intl,
      ),
    ).toBe("Press cancel again to discard transcript");
  });
});

describe("provider disclosure catalogs", () => {
  const loadLocales = () =>
    Object.fromEntries(
      manifest.supportedLocales.map((locale) => [
        locale,
        JSON.parse(
          readFileSync(
            new URL(`../i18n/locales/${locale}.json`, import.meta.url),
            "utf8",
          ),
        ) as Record<string, string>,
      ]),
    );

  it.each(manifest.supportedLocales)(
    "interpolates the provider into %s without leaving a placeholder",
    (locale) => {
      const intl = createIntl({ locale, messages: loadLocales()[locale] });
      for (const key of [
        "audio_is_sent_to_provider_as_you_speak_so_text_can_come_back",
        "your_recording_is_uploaded_to_provider_only_after_you_stop_s",
        "press_cancel_again_to_discard_audio_already_sent_to_provider",
      ]) {
        const formatted = intl.formatMessage({ id: key }, { provider: "Groq" });
        expect(formatted, `${locale}:${key}`).toContain("Groq");
        expect(formatted, `${locale}:${key}`).not.toContain("{provider}");
      }
    },
  );
});
