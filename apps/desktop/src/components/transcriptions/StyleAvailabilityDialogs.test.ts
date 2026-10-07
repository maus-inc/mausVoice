// @vitest-environment jsdom
import type { ApiKey, Tone } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  closeRetranscribeDialog: vi.fn(),
  importAudioFile: vi.fn().mockResolvedValue(undefined),
  openFileDialog: vi.fn().mockResolvedValue("/tmp/import.wav"),
  retranscribeTranscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openFileDialog,
}));

vi.mock("../../actions/transcriptions.actions", () => ({
  closeRetranscribeDialog: mocks.closeRetranscribeDialog,
  importAudioFile: mocks.importAudioFile,
  retranscribeTranscription: mocks.retranscribeTranscription,
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

vi.mock("./TranscriptionsSideEffects", () => ({
  TranscriptionsSideEffects: () => null,
}));

vi.mock("./TranscriptRow", () => ({
  TranscriptionRow: () => null,
}));

vi.mock("../common/ScrollListPage", async () => {
  const { createElement: create } = await import("react");
  return {
    ScrollListPage: ({
      subtitle,
      action,
    }: {
      subtitle: React.ReactNode;
      action?: React.ReactNode;
    }) => create("div", null, subtitle, action),
  };
});

import { RetranscribeDialog } from "./RetranscribeDialog";
import TranscriptionsPage from "./TranscriptionsPage";

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

const alternateTone: Tone = {
  id: "tone-2",
  name: "Clean transcript",
  promptTemplate: "Clean up the transcript.",
  isSystem: false,
  createdAt: 0,
  sortOrder: 1,
};

const postProcessingKey: ApiKey = {
  id: "post-processing-key",
  name: "Post-processing",
  provider: "groq",
  createdAt: "2026-08-19T00:00:00.000Z",
  keyFull: "secret",
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const seedTone = () => {
  produceAppState((draft) => {
    draft.toneById[tone.id] = tone;
    draft.toneById[alternateTone.id] = alternateTone;
  });
};

const enablePostProcessing = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = "api";
    draft.settings.aiPostProcessing.selectedApiKeyId = postProcessingKey.id;
    draft.apiKeyById[postProcessingKey.id] = postProcessingKey;
  });
};

const disablePostProcessing = () => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = "none";
  });
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );

const hasStyleField = (): boolean =>
  [...document.body.querySelectorAll("label")].some(
    (label) => label.textContent?.trim() === "Style",
  );

const findComboboxNamed = (label: string): HTMLElement | undefined =>
  [...document.body.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
    (combobox) =>
      combobox
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .some(
          (id) => document.getElementById(id)?.textContent?.trim() === label,
        ),
  );

const accessibleDialogName = (): string | null => {
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  const titleId = dialog?.getAttribute("aria-labelledby");
  return titleId
    ? (document.getElementById(titleId)?.textContent ?? null)
    : null;
};

const openCombobox = async (label: string): Promise<HTMLElement> => {
  const combobox = findComboboxNamed(label);
  if (!combobox) throw new Error(`Could not find the ${label} selector.`);
  await act(async () => {
    combobox.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
  return combobox;
};

const findMenuItemContainingText = (text: string): HTMLElement | undefined =>
  [...document.body.querySelectorAll<HTMLElement>(".MuiMenuItem-root")].find(
    (item) => item.textContent?.includes(text),
  );

const clickMenuItem = async (item: HTMLElement): Promise<void> => {
  await act(async () => {
    item.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
};

const clickMenuItemContainingText = async (
  text: string,
): Promise<HTMLElement> => {
  const item = findMenuItemContainingText(text);
  if (!item)
    throw new Error(`Could not find the menu item containing ${text}.`);
  await clickMenuItem(item);
  return item;
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe("Import audio style availability", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    seedTone();
    vi.clearAllMocks();
    mocks.openFileDialog.mockResolvedValue("/tmp/import.wav");
    mocks.importAudioFile.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    resetState();
  });

  const renderPage = async () => {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/dashboard/transcriptions"] },
          createElement(TranscriptionsPage),
        ),
      );
    });
  };

  const openImportDialog = async () => {
    const button = findButton("Import audio");
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("shows styles even while post-processing is disabled via fast path", async () => {
    await renderPage();
    await openImportDialog();

    expect(hasStyleField()).toBe(true);
  });

  it("shows styles when post-processing has a usable provider", async () => {
    enablePostProcessing();
    await renderPage();
    await openImportDialog();

    expect(hasStyleField()).toBe(true);
  });

  it("associates Style and Language labels with their selectors", async () => {
    await renderPage();
    await openImportDialog();

    expect(findComboboxNamed("Style")).toBeDefined();
    expect(findComboboxNamed("Language")).toBeDefined();
  });

  it("marks the selected style in the popup", async () => {
    await renderPage();
    await openImportDialog();
    await openCombobox("Style");

    const selectedStyle = findMenuItemContainingText(tone.name);
    expect(selectedStyle?.classList.contains("Mui-selected")).toBe(true);
    expect(selectedStyle?.querySelector(".lucide-check")).not.toBeNull();
  });

  it("keeps the dialog and selected values when the import action returns no file", async () => {
    vi.useFakeTimers();
    try {
      mocks.importAudioFile.mockResolvedValue(false);
      await renderPage();
      await openImportDialog();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      await openCombobox("Style");
      await clickMenuItemContainingText(alternateTone.name);
      await openCombobox("Language");
      await clickMenuItemContainingText("Français");

      const importDialogBeforeImport =
        document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(importDialogBeforeImport).not.toBeNull();
      const chooseFile = findButton("Choose file");
      expect(chooseFile).toBeDefined();
      await act(async () => {
        chooseFile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      await settle();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(document.body.querySelector('[role="dialog"]')).toBe(
        importDialogBeforeImport,
      );

      expect(mocks.importAudioFile).toHaveBeenCalledWith({
        toneId: alternateTone.id,
        languageCode: "fr",
      });
      expect(findButton("Choose file")?.disabled).toBe(false);
      expect(findComboboxNamed("Style")?.textContent).toContain(
        alternateTone.name,
      );
      expect(findComboboxNamed("Language")?.textContent).toContain("Français");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps styles and imports with style when post-processing is turned off (fast path)", async () => {
    enablePostProcessing();
    await renderPage();
    await openImportDialog();
    expect(hasStyleField()).toBe(true);

    act(() => disablePostProcessing());
    // Fast local styling keeps the selector visible
    expect(hasStyleField()).toBe(true);

    const chooseFile = findButton("Choose file");
    expect(chooseFile).toBeDefined();
    await act(async () => {
      chooseFile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settle();

    expect(mocks.importAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ toneId: expect.any(String) }),
    );
  });
});

describe("Retranscribe style availability", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    seedTone();
    vi.clearAllMocks();
    mocks.retranscribeTranscription.mockResolvedValue(undefined);
    produceAppState((draft) => {
      draft.transcriptions.retranscribeDialogOpen = true;
      draft.transcriptions.retranscribeDialogTranscriptionId =
        "transcription-1";
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
      root?.render(createElement(RetranscribeDialog));
    });
  };

  it("labels the dialog with its visible title", async () => {
    await renderDialog();

    expect(accessibleDialogName()).toBe("Retranscribe");
  });

  it("shows styles even while post-processing is disabled via fast path", async () => {
    await renderDialog();

    expect(hasStyleField()).toBe(true);
  });

  it("passes the selected style to retranscription", async () => {
    await renderDialog();

    const stylePicker = await openCombobox("Style");
    const selectedStyle = findMenuItemContainingText(tone.name);
    expect(selectedStyle?.classList.contains("Mui-selected")).toBe(true);
    expect(selectedStyle?.querySelector(".lucide-check")).not.toBeNull();
    await clickMenuItemContainingText(alternateTone.name);
    expect(stylePicker.textContent).toContain(alternateTone.name);

    const languagePicker = await openCombobox("Language");
    await clickMenuItemContainingText("Français");
    expect(languagePicker.textContent).toContain("Français");

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    act(() => {
      transcribe?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: alternateTone.id,
        languageCode: "fr",
      }),
    );
  });

  it("keeps styles visible when post-processing is disabled (fast path)", async () => {
    enablePostProcessing();
    await renderDialog();
    expect(hasStyleField()).toBe(true);

    act(() => disablePostProcessing());
    expect(hasStyleField()).toBe(true);

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    act(() => {
      transcribe?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: expect.any(String),
      }),
    );
  });
});
