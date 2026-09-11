// @vitest-environment jsdom
import type { ApiKey, Tone } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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
    ScrollListPage: ({ subtitle }: { subtitle: React.ReactNode }) =>
      create("div", null, subtitle),
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
      root?.render(createElement(TranscriptionsPage));
    });
  };

  const openImportDialog = async () => {
    const button = findButton("Import audio");
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("hides styles while post-processing is disabled", async () => {
    await renderPage();
    await openImportDialog();

    expect(hasStyleField()).toBe(false);
  });

  it("shows styles when post-processing has a usable provider", async () => {
    enablePostProcessing();
    await renderPage();
    await openImportDialog();

    expect(hasStyleField()).toBe(true);
  });

  it("removes the style live and imports without one when post-processing is turned off", async () => {
    enablePostProcessing();
    await renderPage();
    await openImportDialog();
    expect(hasStyleField()).toBe(true);

    act(() => disablePostProcessing());
    expect(hasStyleField()).toBe(false);

    const chooseFile = findButton("Choose file");
    expect(chooseFile).toBeDefined();
    await act(async () => {
      chooseFile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await settle();

    expect(mocks.importAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ toneId: null }),
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

  it("hides styles while post-processing is disabled", async () => {
    await renderDialog();

    expect(hasStyleField()).toBe(false);
  });

  it("shows styles with a usable provider and removes them live when disabled", async () => {
    enablePostProcessing();
    await renderDialog();
    expect(hasStyleField()).toBe(true);

    act(() => disablePostProcessing());
    expect(hasStyleField()).toBe(false);

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    act(() => {
      transcribe?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: null,
      }),
    );
  });
});
