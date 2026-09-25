// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
  loadApiKeys: vi.fn(async () => undefined),
  updateApiKey: vi.fn(async () => undefined),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
  getTranscriptionModels: vi.fn(async () => [] as string[]),
  getGenerativeTextModels: vi.fn(async () => [] as string[]),
  onChange: vi.fn(),
}));

vi.mock("../../actions/api-key.actions", () => ({
  createApiKey: mocks.createApiKey,
  deleteApiKey: mocks.deleteApiKey,
  loadApiKeys: mocks.loadApiKeys,
  updateApiKey: mocks.updateApiKey,
}));

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: mocks.showSnackbar,
  showErrorSnackbar: mocks.showErrorSnackbar,
}));

vi.mock("../../repos", () => ({
  getModelProviderRepo: () => ({
    supportsTranscriptionModels: () => true,
    supportsGenerativeTextModels: () => true,
    getTranscriptionModels: mocks.getTranscriptionModels,
    getGenerativeTextModels: mocks.getGenerativeTextModels,
  }),
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});

vi.mock("./OpenRouterModelPicker", () => ({
  OpenRouterModelPicker: () =>
    createElement("div", { "data-picker": "openrouter" }),
}));
vi.mock("./OpenRouterProviderRouting", () => ({
  OpenRouterProviderRouting: () => null,
}));
vi.mock("./OllamaModelPicker", () => ({
  OllamaModelPicker: () => createElement("div", { "data-picker": "ollama" }),
}));
vi.mock("./OpenAICompatibleModelPicker", () => ({
  OpenAICompatibleModelPicker: () =>
    createElement("div", { "data-picker": "openai-compatible" }),
}));

import { INITIAL_APP_STATE } from "../../state/app.state";
import {
  INITIAL_SETTINGS_STATE,
  type SettingsApiKey,
} from "../../state/settings.state";
import { produceAppState, useAppStore } from "../../store";
import { ThemeProvider } from "@mui/material";
import { theme } from "../../theme";
import { ApiKeyList } from "./ApiKeyList";

ensureUiHarness();

const groqKey: SettingsApiKey = {
  id: "key-groq",
  name: "Groq key",
  provider: "groq",
  createdAt: "2026-01-01T00:00:00.000Z",
  keySuffix: "abcd",
};

const openRouterKey: SettingsApiKey = {
  id: "key-openrouter",
  name: "OpenRouter key",
  provider: "openrouter",
  createdAt: "2026-01-02T00:00:00.000Z",
};

const seedApiKeys = (apiKeys: SettingsApiKey[]) => {
  produceAppState((draft) => {
    draft.settings = {
      ...INITIAL_SETTINGS_STATE,
      apiKeys,
      apiKeysStatus: "success",
    };
  });
};

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const metaButton = (name: string): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>("[aria-pressed]")].find(
    (candidate) => candidate.textContent?.includes(name),
  );
  if (!el) throw new Error(`Selection region not found for ${name}`);
  return el;
};

describe("ApiKeyList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.setState(INITIAL_APP_STATE, true);
    setMatchMedia(false);
    vi.clearAllMocks();
    mocks.getTranscriptionModels.mockResolvedValue([]);
    mocks.getGenerativeTextModels.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(INITIAL_APP_STATE, true);
    container.remove();
  });

  const renderList = async (
    context: "transcription" | "post-processing" = "post-processing",
    selectedApiKeyId: string | null = "key-groq",
  ) => {
    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { theme },
          createElement(ApiKeyList, {
            selectedApiKeyId,
            onChange: mocks.onChange,
            context,
          }),
        ),
      );
    });
    await flush();
  };

  it("keeps the card header a flat accessibility tree: selection region has no interactive descendants", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    await renderList("post-processing");

    const regions = [
      ...document.querySelectorAll<HTMLElement>("[aria-pressed]"),
    ];
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.getAttribute("role")).toBe("button");
      // WCAG 4.1.2: an interactive container must not nest other
      // interactive controls — the regression this redesign fixed.
      expect(
        region.querySelector("button, input, select, textarea, a, [role]"),
      ).toBeNull();
    }
  });

  it("exposes selection state on the selection region via aria-pressed", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    await renderList("post-processing", "key-groq");

    expect(metaButton("Groq key").getAttribute("aria-pressed")).toBe("true");
    expect(metaButton("OpenRouter key").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("selects on Enter and Space from the keyboard, and only from the meta region", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    await renderList("post-processing", "key-groq");
    mocks.onChange.mockClear();

    const region = metaButton("OpenRouter key");
    await act(async () => {
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(mocks.onChange).toHaveBeenCalledWith("key-openrouter");

    mocks.onChange.mockClear();
    await act(async () => {
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    expect(mocks.onChange).toHaveBeenCalledWith("key-openrouter");

    // The Test button is a sibling, never inside the selection region, so a
    // tap meant for the field cluster cannot re-select the key.
    mocks.onChange.mockClear();
    const testButton = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.trim() === "Test");
    expect(testButton).toBeDefined();
    expect(testButton!.closest("[aria-pressed]")).toBeNull();
  });

  it("captions the model section so the input has a real label", async () => {
    seedApiKeys([openRouterKey]);
    await renderList("post-processing", "key-openrouter");

    const captions = [...document.querySelectorAll("h6, p")].map(
      (el) => el.textContent,
    );
    expect(captions).toContain("Post-processing model");
    expect(document.querySelector('[data-picker="openrouter"]')).not.toBeNull();
  });

  it("renders the generic picker's section only when the provider has models", async () => {
    mocks.getTranscriptionModels.mockResolvedValue(["whisper-large-v3"]);
    seedApiKeys([groqKey]);
    await renderList("transcription", "key-groq");

    const caption = [...document.querySelectorAll("*")].find(
      (el) =>
        el.children.length === 0 && el.textContent === "Transcription model",
    );
    expect(caption).toBeDefined();

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Transcription model"]',
    );
    expect(input).not.toBeNull();
  });

  it("hides the generic picker section entirely when no models are available", async () => {
    mocks.getTranscriptionModels.mockResolvedValue([]);
    seedApiKeys([groqKey]);
    await renderList("transcription", "key-groq");

    const captions = [...document.querySelectorAll("*")].filter(
      (el) =>
        el.children.length === 0 && el.textContent === "Transcription model",
    );
    expect(captions).toHaveLength(0);
    expect(
      document.querySelector('input[aria-label="Transcription model"]'),
    ).toBeNull();
  });
});
