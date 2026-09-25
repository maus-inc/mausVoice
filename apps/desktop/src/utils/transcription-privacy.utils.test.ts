import type { ApiKey } from "@maus-inc/types";
import { readFileSync } from "node:fs";
import { createIntl, type IntlShape } from "react-intl";
import { describe, expect, it } from "vitest";
import manifest from "../i18n/manifest.json";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import {
  getCancelTranscriptPromptMessage,
  getIsCloudTranscriptionSelected,
  getTranscriptionProviderName,
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

describe("transcription privacy disclosure", () => {
  it("gates on the selected mode, so an unset mode stays local", () => {
    expect(getIsCloudTranscriptionSelected(cloudState())).toBe(true);
    expect(getIsCloudTranscriptionSelected(localState())).toBe(false);
    expect(
      getIsCloudTranscriptionSelected(structuredClone(INITIAL_APP_STATE)),
    ).toBe(false);
  });

  it("stays cloud-gated in the transcription dialog before a key exists", () => {
    // Onboarding shows the disclosure the moment API is picked, before any key
    // is saved, so this must not depend on a resolved dispatch preference.
    const selected = stateWith((state) => {
      state.settings.aiTranscription.mode = "api";
    });
    expect(getIsCloudTranscriptionSelected(selected)).toBe(true);
    expect(getTranscriptionProviderName(selected)).toBeNull();
  });

  it("resolves the bare provider display name, never the session label", () => {
    expect(getTranscriptionProviderName(cloudState("assemblyai"))).toBe(
      "AssemblyAI",
    );
    expect(getTranscriptionProviderName(cloudState("deepgram"))).toBe(
      "Deepgram",
    );
  });

  it("names no provider in local mode", () => {
    expect(getTranscriptionProviderName(localState())).toBeNull();
  });

  it("names no provider for a selection that cannot transcribe", () => {
    // A stale selection (no key, a key without a value, or a provider this
    // build has no form config for) falls back to local dispatch, so copy that
    // names a provider must stay hidden instead of rendering a wrong name.
    const noKey = stateWith((state) => {
      state.settings.aiTranscription.mode = "api";
    });
    const noValue = stateWith((state) => {
      state.apiKeyById = {
        "key-1": apiKey("key-1", "assemblyai", { keyFull: null }),
      };
      state.settings.aiTranscription.mode = "api";
      state.settings.aiTranscription.selectedApiKeyId = "key-1";
    });
    const unknownProvider = stateWith((state) => {
      state.apiKeyById = {
        "key-1": apiKey("key-1", "from-the-future" as ApiKey["provider"]),
      };
      state.settings.aiTranscription.mode = "api";
      state.settings.aiTranscription.selectedApiKeyId = "key-1";
    });
    expect(getTranscriptionProviderName(noKey)).toBeNull();
    expect(getTranscriptionProviderName(noValue)).toBeNull();
    expect(getTranscriptionProviderName(unknownProvider)).toBeNull();
  });
});

describe("cancel transcript prompt", () => {
  // A stub, not a real intl: the point here is which branch is taken and which
  // values it interpolates. The catalogs themselves are exercised below, and
  // the dialog test formats the same copy through the real provider.
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

  it("warns that sent audio cannot be recalled on a cloud provider", () => {
    expect(
      getCancelTranscriptPromptMessage(cloudState("assemblyai"), intl),
    ).toBe(
      "Press cancel again to discard. Audio already sent to AssemblyAI can't be recalled.",
    );
  });

  it("keeps the local wording in local mode", () => {
    expect(getCancelTranscriptPromptMessage(localState(), intl)).toBe(
      "Press cancel again to discard transcript",
    );
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
        "audio_is_sent_to_provider_while_you_dictate_so_text_can_come",
        "press_cancel_again_to_discard_audio_already_sent_to_provider",
      ]) {
        const formatted = intl.formatMessage(
          { id: key },
          {
            provider: "AssemblyAI",
          },
        );
        expect(formatted, `${locale}:${key}`).toContain("AssemblyAI");
        expect(formatted, `${locale}:${key}`).not.toContain("{provider}");
      }
    },
  );
});
