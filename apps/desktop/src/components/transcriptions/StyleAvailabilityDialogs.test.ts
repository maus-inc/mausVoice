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
  retranscribeTranscriptionWithRecovery: vi.fn().mockResolvedValue({
    started: true,
    update: null,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openFileDialog,
}));

vi.mock("../../actions/transcriptions.actions", () => ({
  closeRetranscribeDialog: mocks.closeRetranscribeDialog,
  importAudioFile: mocks.importAudioFile,
  retranscribeTranscriptionWithRecovery:
    mocks.retranscribeTranscriptionWithRecovery,
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
  name: "Email",
  promptTemplate: "Format as a concise email.",
  isSystem: false,
  createdAt: 0,
  sortOrder: 1,
};

const newestTone: Tone = {
  id: "tone-3",
  name: "Chat",
  promptTemplate: "Format as a chat message.",
  isSystem: false,
  createdAt: 2,
  sortOrder: 2,
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

const expectSelectLabels = () => {
  const controls = [
    ...document.body.querySelectorAll<HTMLElement>(
      '[role="dialog"] [role="combobox"]',
    ),
  ];
  expect(controls).toHaveLength(2);
  for (const [control, label] of controls.map(
    (control, i) => [control, ["Style", "Language"][i]] as const,
  )) {
    const references = (control.getAttribute("aria-labelledby") ?? "").split(
      " ",
    );
    expect(
      references.some(
        (id) => document.getElementById(id)?.textContent === label,
      ),
    ).toBe(true);
  }
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const chooseOption = async (select: HTMLElement, label: string) => {
  await act(async () => {
    select.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });
  await settle();

  const option = [
    ...document.body.querySelectorAll<HTMLElement>(
      '[role="option"], [role="menuitem"]',
    ),
  ].find((candidate) => candidate.textContent?.includes(label));
  expect(option).toBeDefined();
  if (!option) throw new Error(`${label} option was not rendered.`);

  await act(async () => {
    option.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
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
    expectSelectLabels();
  });

  it("shows styles when post-processing has a usable provider", async () => {
    enablePostProcessing();
    await renderPage();
    await openImportDialog();

    expect(hasStyleField()).toBe(true);
    expectSelectLabels();
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
    mocks.retranscribeTranscriptionWithRecovery.mockResolvedValue({
      started: true,
      update: null,
    });
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

  it("shows styles even while post-processing is disabled via fast path", async () => {
    await renderDialog();

    expect(hasStyleField()).toBe(true);
    expectSelectLabels();
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

    expect(mocks.retranscribeTranscriptionWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: expect.any(String),
      }),
    );
  });

  it("uses the newly selected style for retranscription", async () => {
    produceAppState((draft) => {
      draft.toneById[alternateTone.id] = alternateTone;
    });
    await renderDialog();

    const styleSelect = document.querySelector<HTMLElement>(
      '[role="dialog"] [role="combobox"]',
    );
    expect(styleSelect).toBeDefined();
    if (!styleSelect) throw new Error("Style selector was not rendered.");
    expect(styleSelect.textContent).toContain(tone.name);

    await chooseOption(styleSelect, alternateTone.name);
    expect(styleSelect.textContent).toContain(alternateTone.name);

    const languageSelect = document.querySelectorAll<HTMLElement>(
      '[role="dialog"] [role="combobox"]',
    )[1];
    expect(languageSelect).toBeDefined();
    if (!languageSelect) throw new Error("Language selector was not rendered.");

    await chooseOption(languageSelect, "Français");

    expect(languageSelect.textContent).toContain("Français");
    expect(styleSelect.textContent).toContain(alternateTone.name);

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    if (!transcribe) throw new Error("Transcribe button was not rendered.");
    await act(async () => {
      transcribe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscriptionWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: alternateTone.id,
        languageCode: "fr",
      }),
    );
  });

  it("keeps selections when available styles change", async () => {
    produceAppState((draft) => {
      draft.toneById[alternateTone.id] = alternateTone;
    });
    await renderDialog();

    const [styleSelect, languageSelect] =
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"] [role="combobox"]',
      );
    expect(styleSelect).toBeDefined();
    expect(languageSelect).toBeDefined();
    if (!styleSelect || !languageSelect) {
      throw new Error("Retranscription selectors were not rendered.");
    }

    await chooseOption(styleSelect, alternateTone.name);
    await chooseOption(languageSelect, "Français");

    await act(async () => {
      produceAppState((draft) => {
        draft.toneById[newestTone.id] = newestTone;
      });
    });

    expect(styleSelect.textContent).toContain(alternateTone.name);
    expect(languageSelect.textContent).toContain("Français");

    await act(async () => {
      produceAppState((draft) => {
        delete draft.toneById[alternateTone.id];
      });
    });

    expect(styleSelect.textContent).toContain(tone.name);
    expect(languageSelect.textContent).toContain("Français");

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    if (!transcribe) throw new Error("Transcribe button was not rendered.");
    await act(async () => {
      transcribe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscriptionWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: tone.id,
        languageCode: "fr",
      }),
    );
  });

  it("falls back to the first remaining style when the selection and default disappear", async () => {
    produceAppState((draft) => {
      draft.toneById[alternateTone.id] = alternateTone;
    });
    await renderDialog();

    const styleSelect = document.querySelector<HTMLElement>(
      '[role="dialog"] [role="combobox"]',
    );
    expect(styleSelect).toBeDefined();
    if (!styleSelect) throw new Error("Style selector was not rendered.");

    await chooseOption(styleSelect, alternateTone.name);

    await act(async () => {
      produceAppState((draft) => {
        draft.toneById[newestTone.id] = newestTone;
        delete draft.toneById[alternateTone.id];
        delete draft.toneById[tone.id];
      });
    });

    expect(styleSelect.textContent).toContain(newestTone.name);

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    if (!transcribe) throw new Error("Transcribe button was not rendered.");
    await act(async () => {
      transcribe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscriptionWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: newestTone.id,
      }),
    );
  });

  it("does not submit a stale style when no styles remain", async () => {
    await renderDialog();

    const styleSelect = document.querySelector<HTMLElement>(
      '[role="dialog"] [role="combobox"]',
    );
    expect(styleSelect).toBeDefined();
    if (!styleSelect) throw new Error("Style selector was not rendered.");
    expect(styleSelect.textContent).toContain(tone.name);

    await act(async () => {
      produceAppState((draft) => {
        delete draft.toneById[tone.id];
      });
    });

    expect(styleSelect.textContent).not.toContain(tone.name);

    const transcribe = findButton("Transcribe");
    expect(transcribe).toBeDefined();
    if (!transcribe) throw new Error("Transcribe button was not rendered.");
    await act(async () => {
      transcribe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.retranscribeTranscriptionWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionId: "transcription-1",
        toneId: null,
      }),
    );
  });

  it("loads current defaults when the dialog opens again", async () => {
    produceAppState((draft) => {
      draft.toneById[alternateTone.id] = alternateTone;
    });
    await renderDialog();

    const [styleSelect, languageSelect] =
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"] [role="combobox"]',
      );
    expect(styleSelect).toBeDefined();
    expect(languageSelect).toBeDefined();
    if (!styleSelect || !languageSelect) {
      throw new Error("Retranscription selectors were not rendered.");
    }

    await chooseOption(styleSelect, alternateTone.name);
    await chooseOption(languageSelect, "Français");

    await act(async () => {
      produceAppState((draft) => {
        draft.transcriptions.retranscribeDialogOpen = false;
      });
    });
    await act(async () => {
      produceAppState((draft) => {
        draft.toneById[newestTone.id] = newestTone;
        draft.dictationLanguageOverride = "de";
      });
    });
    await act(async () => {
      produceAppState((draft) => {
        draft.transcriptions.retranscribeDialogOpen = true;
      });
    });

    expect(styleSelect.textContent).toContain(newestTone.name);
    expect(languageSelect.textContent).toContain("Deutsch");
  });
});
