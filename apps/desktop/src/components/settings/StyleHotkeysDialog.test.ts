// @vitest-environment jsdom
import type { ApiKey, Tone } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({
    replaceStyleHotkeys: vi.fn().mockResolvedValue([]),
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

import { StyleHotkeysDialog } from "./StyleHotkeysDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tone: Tone = {
  id: "tone-1",
  name: "Meeting notes",
  promptTemplate: "Use concise meeting notes.",
  isSystem: false,
  createdAt: 1,
  sortOrder: 0,
};

const postProcessingKey: ApiKey = {
  id: "post-processing-key",
  name: "Post-processing",
  provider: "groq",
  createdAt: "2026-08-19T00:00:00.000Z",
  keyFull: "secret",
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const setPostProcessingEnabled = (enabled: boolean) => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = enabled ? "api" : "none";
    draft.settings.aiPostProcessing.selectedApiKeyId = enabled
      ? postProcessingKey.id
      : null;
    if (enabled) {
      draft.apiKeyById[postProcessingKey.id] = postProcessingKey;
    }
  });
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );

const findEditableHotkey = (): HTMLDivElement | undefined =>
  [...document.body.querySelectorAll<HTMLDivElement>('div[tabindex="0"]')].find(
    (element) => element.textContent?.trim() === "Set hotkey",
  );

describe("StyleHotkeysDialog post-processing gate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    produceAppState((draft) => {
      draft.settings.styleHotkeysDialogOpen = true;
      draft.toneById[tone.id] = tone;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    resetState();
  });

  const renderDialog = async () => {
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(StyleHotkeysDialog));
    });
  };

  it("renders non-functional hotkey rows and disables save when post-processing is off", async () => {
    setPostProcessingEnabled(false);
    await renderDialog();

    const disabledHotkey = findButton("Set hotkey");
    expect(disabledHotkey?.disabled).toBe(true);
    expect(findButton("Save")?.disabled).toBe(true);
    expect(findEditableHotkey()).toBeUndefined();

    await act(async () => {
      disabledHotkey?.parentElement?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(document.body.textContent).toContain(
      "Post-processing must be enabled to use writing styles.",
    );
  });

  it("keeps hotkey editing available when post-processing is configured", async () => {
    setPostProcessingEnabled(true);
    await renderDialog();

    expect(findEditableHotkey()).toBeDefined();
    expect(findButton("Save")?.disabled).toBe(false);
  });

  it("disables rows immediately when post-processing is turned off", async () => {
    setPostProcessingEnabled(true);
    await renderDialog();
    expect(findEditableHotkey()).toBeDefined();

    act(() => setPostProcessingEnabled(false));

    expect(findButton("Set hotkey")?.disabled).toBe(true);
    expect(findButton("Save")?.disabled).toBe(true);
    expect(findEditableHotkey()).toBeUndefined();
  });
});
