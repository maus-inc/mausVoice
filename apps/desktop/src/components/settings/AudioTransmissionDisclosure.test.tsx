// @vitest-environment jsdom
import type { ApiKey } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { AudioTransmissionDisclosure } from "./AudioTransmissionDisclosure";
import en from "../../i18n/locales/en.json";
import {
  createTranscriptionSession,
  AzureTranscriptionSession,
  BatchTranscriptionSession,
  AssemblyAITranscriptionSession,
  DeepgramTranscriptionSession,
  ElevenLabsTranscriptionSession,
  GladiaTranscriptionSession,
} from "../../sessions";
import { TRANSCRIPTION_CAPABLE_PROVIDERS } from "../../utils/user.utils";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LIVE_STREAMING_CLASSES = [
  AssemblyAITranscriptionSession,
  DeepgramTranscriptionSession,
  ElevenLabsTranscriptionSession,
  GladiaTranscriptionSession,
  AzureTranscriptionSession,
];

const selectCloudProvider = (provider: ApiKey["provider"]) =>
  setAppState(
    (() => {
      const state = structuredClone(INITIAL_APP_STATE);
      state.apiKeyById = {
        "key-1": {
          id: "key-1",
          name: "key-1",
          provider,
          createdAt: "2026-01-01T00:00:00.000Z",
          keyFull: "sk-test",
        },
      };
      state.settings.aiTranscription.mode = "api";
      state.settings.aiTranscription.selectedApiKeyId = "key-1";
      return state;
    })(),
    true,
  );

const sessionStreamsLive = (provider: ApiKey["provider"]): boolean => {
  const session = createTranscriptionSession({
    mode: "api",
    provider,
    apiKeyId: "key-1",
    apiKeyValue: "sk-test",
    transcriptionModel: null,
    warnings: [],
  });
  if (provider === "azure") {
    // Pin the premise of the test: Azure streams and says it does not.
    expect(session).toBeInstanceOf(AzureTranscriptionSession);
    expect(session.supportsStreaming()).toBe(false);
  }
  return LIVE_STREAMING_CLASSES.some((cls) => session instanceof cls);
};
describe("AudioTransmissionDisclosure", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AudioTransmissionDisclosure),
        ),
      );
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says nothing in local mode, because nothing leaves the machine", () => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    render();
    expect(container.textContent).toBe("");
  });

  // The acceptance test for the finding: for every transcription-capable
  // provider, the sentence on screen has to match the session that provider
  // actually gets, not the blanket claim the old copy made.
  it.each([...TRANSCRIPTION_CAPABLE_PROVIDERS])(
    "matches the session built for %s",
    (provider) => {
      selectCloudProvider(provider);
      render();
      const text = container.textContent ?? "";

      if (sessionStreamsLive(provider)) {
        expect(text).toContain("as you speak");
        expect(text).toContain("cannot be recalled");
        expect(text).not.toContain("only after you stop");
      } else {
        expect(text).toContain("only after you stop");
        expect(text).not.toContain("as you speak");
        expect(text).not.toContain("cannot be recalled");
      }
    },
  );

  it("names the provider so the sentence has a subject", () => {
    selectCloudProvider("groq");
    render();
    expect(container.textContent).toContain("Groq");
  });

  it("stays a fragment so the settings page can place it as a description", () => {
    selectCloudProvider("groq");
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AudioTransmissionDisclosure, { variant: "setting" }),
        ),
      );
    });
    // The sentence variant would wrap the text in a Typography paragraph; the
    // setting variant must not, or the description would nest a block element.
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).toContain("only after you stop");
  });

  it("does not claim a batch provider is a streaming one", () => {
    // Guards the exact regression: BatchTranscriptionSession used to be
    // described as streaming, which told the user their audio was on the
    // provider before recording stopped.
    selectCloudProvider("groq");
    render();
    const session = createTranscriptionSession({
      mode: "api",
      provider: "groq",
      apiKeyId: "key-1",
      apiKeyValue: "sk-test",
      transcriptionModel: null,
      warnings: [],
    });
    expect(session).toBeInstanceOf(BatchTranscriptionSession);
    expect(container.textContent).not.toMatch(/as you speak/);
  });
});
