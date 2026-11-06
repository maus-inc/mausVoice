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
  createApiKey: vi.fn(() => Promise.resolve()),
  deleteApiKey: vi.fn(() => Promise.resolve()),
  loadApiKeys: vi.fn(() => Promise.resolve()),
  updateApiKey: vi.fn(() => Promise.resolve()),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn<(message: unknown) => void>(),
  getTranscriptionModels: vi.fn(() => Promise.resolve([] as string[])),
  getGenerativeTextModels: vi.fn(() => Promise.resolve([] as string[])),
  onChange: vi.fn(),
  holdTest: false,
  overrideTest: false,
  testIntegration: vi.fn(),
  releaseTest: null as null | (() => void),
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

// Wraps the real config so most tests keep the real behaviour, and the
// mid-test test can hold testIntegration open to observe a card in flight.
vi.mock("./api-key-provider-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./api-key-provider-config")>();
  return {
    ...actual,
    getProviderFormConfig: (
      provider: Parameters<typeof actual.getProviderFormConfig>[0],
      context: Parameters<typeof actual.getProviderFormConfig>[1],
    ) => {
      const config = actual.getProviderFormConfig(provider, context);
      if (mocks.overrideTest)
        return { ...config, testIntegration: mocks.testIntegration };
      if (!mocks.holdTest) return config;
      return {
        ...config,
        testIntegration: () =>
          new Promise<boolean>((resolve) => {
            mocks.releaseTest?.();
            mocks.releaseTest = () => resolve(false);
          }),
      };
    },
  };
});

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

const testButton = (): HTMLButtonElement => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Test",
  );
  if (!el) throw new Error("Test button not found");
  return el;
};

describe("ApiKeyList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.setState(INITIAL_APP_STATE, true);
    setMatchMedia(false);
    vi.clearAllMocks();
    mocks.overrideTest = false;
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
    compactCards = false,
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
            compactCards,
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
      // A real <button type="button">, not a div with role="button". Enter and
      // Space activation, Space not scrolling the page, and form participation
      // come from the element, so there is no keydown handler to keep in sync.
      expect(region.tagName).toBe("BUTTON");
      expect(region.getAttribute("type")).toBe("button");
      expect(region.getAttribute("role")).toBeNull();
      // WCAG 4.1.2: an interactive container must not nest other
      // interactive controls — the regression this redesign fixed.
      expect(
        region.querySelector("button, input, select, textarea, a, [role]"),
      ).toBeNull();
    }
  });

  it.each([
    ["loading", "Loading API keys…"],
    ["error", "Failed to load API keys"],
    ["success", "No API keys yet"],
  ] as const)(
    "renders the %s state when there are no keys",
    async (status, message) => {
      seedApiKeys([]);
      produceAppState((draft) => {
        draft.settings.apiKeysStatus = status;
      });
      await renderList("transcription", null);

      expect(container.textContent).toContain(message);
      expect(container.querySelector("[aria-pressed]")).toBeNull();
    },
  );

  it.each(["loading", "error", "idle", "success"] as const)(
    "keeps saved keys usable during %s",
    async (status) => {
      seedApiKeys([groqKey]);
      produceAppState((draft) => {
        draft.settings.apiKeysStatus = status;
      });
      await renderList();
      expect(metaButton("Groq key")).toBeDefined();
      expect(container.textContent).not.toContain("No API keys yet");
      expect(container.textContent).not.toContain("Failed to load API keys");
      expect(container.textContent).not.toContain("Loading API keys…");
    },
  );

  it.each(["success", "error"] as const)(
    "opens the add form from the %s empty state",
    async (status) => {
      seedApiKeys([]);
      produceAppState((draft) => {
        draft.settings.apiKeysStatus = status;
      });
      await renderList("transcription", null);
      const button = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((candidate) => candidate.textContent?.includes("Add"));
      if (!button) throw new Error("add action missing");
      await act(async () => button.click());
      expect(container.textContent).toContain("Key name");
      expect(container.textContent).not.toContain("No API keys yet");
      if (status === "error")
        expect(container.textContent).toContain("Failed to load API keys");
    },
  );

  it.each([null, "missing"])(
    "selects the first available key when the selected key is %s",
    async (selected) => {
      seedApiKeys([groqKey, openRouterKey]);
      await renderList("post-processing", selected);
      expect(mocks.onChange).toHaveBeenCalledWith(groqKey.id);
    },
  );

  it("does not replace a selection made while a new API key is saving", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    let finish!: (key: SettingsApiKey) => void;
    mocks.createApiKey.mockReturnValueOnce(
      new Promise<SettingsApiKey>((resolve) => {
        finish = resolve;
      }) as unknown as Promise<void>,
    );
    await renderList();
    const add = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("Add another key"));
    if (!add) throw new Error("add button missing");
    await act(async () => add.click());
    const name = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g., My API Key"]',
    );
    const secret = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    if (!name || !secret) throw new Error("add fields missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(name, "New key");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(secret, "secret");
      secret.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Save");
    if (!save) throw new Error("save button missing");
    await act(async () => save.click());
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1);
    await act(async () => metaButton("OpenRouter key").click());
    await renderList("post-processing", "key-openrouter");
    mocks.onChange.mockClear();
    await act(async () => finish({ ...groqKey, id: "new", name: "New key" }));
    expect(mocks.onChange).not.toHaveBeenCalledWith("new");
  });

  it("selects a created key when the selection has not changed", async () => {
    seedApiKeys([groqKey]);
    mocks.createApiKey.mockResolvedValueOnce({
      ...groqKey,
      id: "new",
      name: "New key",
    } as unknown as void);
    await renderList();
    const add = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("Add another key"));
    if (!add) throw new Error("add button missing");
    await act(async () => add.click());
    const name = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g., My API Key"]',
    );
    const secret = container.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    if (!name || !secret) throw new Error("add fields missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(name, "New key");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(secret, "secret");
      secret.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Save");
    if (!save) throw new Error("save button missing");
    await act(async () => save.click());
    expect(mocks.onChange).toHaveBeenCalledWith("new");
  });

  it("allows long key names to wrap within the selection region", async () => {
    const longName = "long-key-name".repeat(20);
    seedApiKeys([{ ...groqKey, name: longName }, openRouterKey]);
    await renderList("transcription", "key-groq", true);

    const region = metaButton(longName);
    const grid = region.closest(".MuiPaper-root")?.parentElement;
    expect(grid).toBeDefined();
    expect(getComputedStyle(grid!).display).toBe("grid");
    expect(getComputedStyle(grid!).gridTemplateColumns).toContain("auto-fit");
    const name = [...region.querySelectorAll<HTMLElement>("p")].find(
      (element) => element.textContent === longName,
    );
    expect(name).toBeDefined();
    expect(getComputedStyle(name!).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(name!).minWidth).toBe("0px");
    expect(testButton().closest("[aria-pressed]")).toBeNull();
  });

  it("exposes selection state on the selection region via aria-pressed", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    await renderList("post-processing", "key-groq");

    expect(metaButton("Groq key").getAttribute("aria-pressed")).toBe("true");
    expect(metaButton("OpenRouter key").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("activates the selection region through the native button, and only there", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    await renderList("post-processing", "key-groq");
    mocks.onChange.mockClear();

    // Keyboard activation is the browser's job for a native button, which is
    // why the element is one. jsdom does not implement the Enter and Space
    // default actions, so the assertion is on the element that gets them
    // rather than on a hand-rolled keydown handler.
    const region = metaButton("OpenRouter key");
    expect(region.tagName).toBe("BUTTON");
    await act(async () => {
      region.click();
    });
    expect(mocks.onChange).toHaveBeenCalledWith("key-openrouter");

    // The Test button is a sibling, never inside the selection region, so a
    // tap meant for the field cluster cannot re-select the key.
    expect(testButton().closest("[aria-pressed]")).toBeNull();
  });

  it("keeps the selection region focusable while the card is mid-test, and inert", async () => {
    seedApiKeys([groqKey]);
    await renderList("post-processing", "key-groq");

    expect(metaButton("Groq key").hasAttribute("disabled")).toBe(false);

    // Hold the integration test open so the card is observably in flight.
    mocks.holdTest = true;

    await act(async () => {
      testButton().click();
    });
    await flush();

    // The action buttons are disabled here, so the selection region has to be
    // inert too, or a card whose test is in flight still toggles the active
    // key. It is `aria-disabled` rather than `disabled` so it keeps its place in
    // the tab order: a natively disabled button is removed from it and blurs
    // itself if it held focus, which dropped a keyboard user back to `<body>`
    // and sent their next Tab to the top of the settings page.
    const region = metaButton("Groq key") as HTMLButtonElement;
    expect(region.getAttribute("aria-disabled")).toBe("true");
    expect(region.hasAttribute("disabled")).toBe(false);
    expect(region.disabled).toBe(false);

    region.focus();
    expect(document.activeElement).toBe(region);

    mocks.onChange.mockClear();
    region.click();
    expect(mocks.onChange).not.toHaveBeenCalled();
    // Clicking an inert region must not move focus off it either.
    expect(document.activeElement).toBe(region);

    await act(async () => {
      mocks.releaseTest?.();
    });
    await flush();
    mocks.holdTest = false;
    mocks.releaseTest = null;

    expect(metaButton("Groq key").getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps each provider test busy until its own request settles", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    mocks.overrideTest = true;
    const finish: Array<(value: boolean) => void> = [];
    mocks.testIntegration.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish.push(resolve);
        }),
    );
    await renderList();
    const buttonFor = (name: string) => {
      const button = [
        ...(metaButton(name)
          .closest(".MuiPaper-root")
          ?.querySelectorAll<HTMLButtonElement>("button") ?? []),
      ].find((candidate) => candidate.textContent?.trim() === "Test");
      if (!button) throw new Error(`Test button missing for ${name}`);
      return button;
    };
    const first = buttonFor("Groq key");
    const second = buttonFor("OpenRouter key");
    await act(async () => {
      first.click();
      second.click();
    });
    expect(mocks.testIntegration).toHaveBeenCalledTimes(2);
    expect(metaButton("Groq key").getAttribute("aria-disabled")).toBe("true");
    expect(metaButton("OpenRouter key").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () => finish[0](true));
    expect(metaButton("Groq key").getAttribute("aria-disabled")).toBe("false");
    expect(metaButton("OpenRouter key").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () => finish[1](true));
    expect(metaButton("OpenRouter key").getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("does not start a duplicate test on a double click before the busy state renders", async () => {
    seedApiKeys([groqKey]);
    mocks.overrideTest = true;
    let finish!: (value: boolean) => void;
    mocks.testIntegration.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await renderList();
    const button = testButton();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(mocks.testIntegration).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });

  it("ignores late provider-test notifications after the list unmounts", async () => {
    seedApiKeys([groqKey]);
    mocks.overrideTest = true;
    let finish!: (value: boolean) => void;
    mocks.testIntegration.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await renderList();
    await act(async () => testButton().click());
    await act(async () => root.unmount());
    await act(async () => finish(true));
    expect(mocks.showSnackbar).not.toHaveBeenCalled();
    expect(mocks.showErrorSnackbar).not.toHaveBeenCalled();
  });

  it("submits a key deletion only once for a double confirmation", async () => {
    seedApiKeys([groqKey]);
    let finish!: () => void;
    mocks.deleteApiKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await renderList();
    const deleteButton = container
      .querySelector("svg.lucide-trash-2")
      ?.closest("button");
    if (!deleteButton) throw new Error("delete action missing");
    await act(async () => deleteButton.click());
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Delete");
    if (!confirm) throw new Error("delete confirmation missing");
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.deleteApiKey).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it.each(["card", "editing"])(
    "reports successful and failed provider checks from %s",
    async (surface) => {
      seedApiKeys([groqKey]);
      mocks.overrideTest = true;
      mocks.testIntegration
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error("provider unavailable"));
      await renderList("post-processing", "key-groq");
      if (surface === "editing") {
        const edit = container
          .querySelector("svg.lucide-pencil")
          ?.closest("button");
        if (!edit) throw new Error("Edit button not found");
        await act(async () => edit.click());
      }
      await act(async () => testButton().click());
      await flush();
      expect(mocks.testIntegration).toHaveBeenCalledWith(
        expect.objectContaining({ id: groqKey.id, provider: "groq" }),
        "post-processing",
      );
      expect(mocks.showSnackbar).toHaveBeenCalledWith(
        "Integration successful",
        { mode: "success" },
      );
      await act(async () => testButton().click());
      await flush();
      expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(
        "Integration failed. Provide a valid API key.",
      );
      await act(async () => testButton().click());
      await flush();
      expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(
        "provider unavailable",
      );
    },
  );

  it("does not display credentials echoed by a failed provider test", async () => {
    seedApiKeys([groqKey]);
    mocks.overrideTest = true;
    mocks.testIntegration.mockRejectedValueOnce(
      new Error("Authorization: Bearer sensitive-provider-credential"),
    );
    await renderList();
    await act(async () => testButton().click());
    expect(mocks.showErrorSnackbar).toHaveBeenCalledOnce();
    const displayed = String(mocks.showErrorSnackbar.mock.calls[0][0]);
    expect(displayed).not.toContain("sensitive-provider-credential");
    expect(displayed).toContain("[redacted]");
  });

  it("redacts the supplied key even when the provider echoes it without a credential label", async () => {
    const key = "unlabeled-provider-credential";
    seedApiKeys([{ ...groqKey, keyFull: key }]);
    mocks.overrideTest = true;
    mocks.testIntegration.mockRejectedValueOnce(
      new Error(`Upstream rejected ${key} at the endpoint`),
    );
    await renderList();
    await act(async () => testButton().click());
    expect(mocks.showErrorSnackbar).toHaveBeenCalledOnce();
    const displayed = String(mocks.showErrorSnackbar.mock.calls[0][0]);
    expect(displayed).not.toContain(key);
    expect(displayed).toContain("[redacted]");
  });

  it("does not test an unsaved OpenAI-compatible endpoint change", async () => {
    const key: SettingsApiKey = {
      ...groqKey,
      provider: "openai-compatible",
      baseUrl: "https://old.example.com",
    };
    seedApiKeys([key]);
    mocks.overrideTest = true;
    await renderList("post-processing", key.id);
    const edit = container
      .querySelector("svg.lucide-pencil")
      ?.closest("button");
    if (!edit) throw new Error("Edit button not found");
    await act(async () => edit.click());
    const url = Array.from(
      container.querySelectorAll<HTMLInputElement>("input"),
    ).find((input) => input.value === key.baseUrl);
    if (!url) throw new Error("Endpoint input not found");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(url, "https://new.example.com");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => testButton().click());
    expect(mocks.testIntegration).not.toHaveBeenCalled();
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(
      "Save endpoint URL changes before testing them.",
    );
  });

  it.each([
    {
      provider: "groq" as const,
      context: "post-processing" as const,
      expectedModel: undefined,
      expectedPath: undefined,
      clearPath: false,
    },
    {
      provider: "openai-compatible" as const,
      context: "transcription" as const,
      expectedModel: null,
      expectedPath: null,
      clearPath: true,
    },
  ])(
    "preserves unset versus cleared fields when editing $provider",
    async ({ provider, context, expectedModel, expectedPath, clearPath }) => {
      const key: SettingsApiKey = {
        ...groqKey,
        provider,
        baseUrl: "https://example.com",
        transcriptionModel: "old-model",
        transcriptionPath: "/old-path",
      };
      seedApiKeys([key]);
      await renderList(context, key.id);
      const edit = container
        .querySelector("svg.lucide-pencil")
        ?.closest("button");
      if (!edit) throw new Error("Edit button not found");
      await act(async () => edit.click());
      for (const value of ["old-model", "/old-path"]) {
        const input = [
          ...container.querySelectorAll<HTMLInputElement>("input"),
        ].find((element) => element.value === value);
        if (provider === "openai-compatible") expect(input).toBeDefined();
        else expect(input).toBeUndefined();
        if (input) {
          await act(async () => {
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )?.set?.call(input, "");
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
        }
      }
      const save = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Save");
      if (!save) throw new Error("Save button not found");
      await act(async () => save.click());
      await flush();
      expect(mocks.updateApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          id: key.id,
          transcriptionModel: expectedModel,
          transcriptionPath: expectedPath,
          clearTranscriptionPath: clearPath,
        }),
      );
    },
  );

  it("keeps a newer key editor open when an older save completes", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    let finish!: () => void;
    mocks.updateApiKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await renderList();
    const editFor = (name: string) =>
      metaButton(name)
        .closest(".MuiPaper-root")
        ?.querySelector("svg.lucide-pencil")
        ?.closest("button");
    const first = editFor("Groq key");
    if (!first) throw new Error("first edit missing");
    await act(async () => first.click());
    const save = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Save");
    if (!save) throw new Error("save missing");
    await act(async () => save.click());
    const second = editFor("OpenRouter key");
    if (!second) throw new Error("second edit missing");
    await act(async () => second.click());
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === "OpenRouter key",
      ),
    ).toBe(true);
    await act(async () => finish());
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === "OpenRouter key",
      ),
    ).toBe(true);
  });

  it("keeps a reopened editor for the same key after an earlier save finishes", async () => {
    seedApiKeys([groqKey, openRouterKey]);
    let finish!: () => void;
    mocks.updateApiKey.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await renderList();
    const editFor = (name: string) =>
      metaButton(name)
        .closest(".MuiPaper-root")
        ?.querySelector("svg.lucide-pencil")
        ?.closest("button");
    await act(async () => editFor("Groq key")?.click());
    const save = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Save");
    if (!save) throw new Error("save missing");
    await act(async () => save.click());
    await act(async () => editFor("OpenRouter key")?.click());
    await act(async () => editFor("Groq key")?.click());
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === "Groq key",
      ),
    ).toBe(true);
    await act(async () => finish());
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === "Groq key",
      ),
    ).toBe(true);
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
