// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Tracks VoiceInstructionRecorder construction/disposal so we can prove the
// recorder is built inside an effect — exactly one live instance under
// StrictMode's mount → cleanup → remount cycle — rather than during render,
// which would leak an undisposed instance on StrictMode's double render.
let constructCount = 0;
let disposeCount = 0;

vi.mock("./voiceInstructionRecorder", () => ({
  VoiceInstructionRecorder: class {
    constructor() {
      constructCount++;
    }
    dispose() {
      disposeCount++;
    }
  },
}));

vi.mock("react-intl", () => {
  // One stub for the file: useIntl() must return a stable reference, like the
  // real provider does. A fresh object per render would re-run every effect
  // that lists intl in its deps (e.g. the composer's transcript load) and let
  // a late peek overwrite state set after mount.
  const stub = {
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
  return {
    useIntl: () => stub,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../../actions/composer.actions", () => ({
  applyVoiceEditInstruction: vi.fn().mockResolvedValue("edited"),
}));
vi.mock("../../actions/transcribe.actions", () => ({
  transcribeAudio: vi.fn().mockResolvedValue({ sanitizedTranscript: "" }),
}));
vi.mock("../../repos", () => ({
  getTranscribeAudioRepo: () => {
    if (!fakeState.settings?.aiTranscription?.enabled) {
      throw new Error("No transcription provider configured");
    }
    return { repo: {} };
  },
  getGenerateTextRepo: () => {
    if (!fakeState.userPrefs?.hasProvider) {
      throw new Error("No generation provider configured");
    }
    return { repo: {} };
  },
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn() }),
}));
vi.mock("../../utils/user.utils", () => ({
  getMyPreferredMicrophone: () => null,
}));

let fakeState = {
  settings: { aiTranscription: { enabled: false } },
  apiKeyById: {},
  userPrefs: { hasProvider: false },
};
vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(fakeState),
  getAppState: () => fakeState,
  produceAppState: (fn: (draft: Record<string, unknown>) => void) => fn({}),
}));

import { ComposerPage } from "./ComposerPage";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { invoke } from "@tauri-apps/api/core";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ComposerPage VoiceInstructionRecorder lifecycle", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    constructCount = 0;
    disposeCount = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("builds exactly one live recorder under StrictMode (no render-phase leak)", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(StrictMode, null, createElement(ComposerPage)));
    });
    // Let the StrictMode mount → cleanup → remount cycle and microtasks settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // StrictMode mounts, runs the recorder effect (construct #1), cleans it up
    // (dispose #1), then remounts and runs the effect again (construct #2).
    // A correct effect-based implementation therefore has exactly one live
    // instance and a recorded disposal. A render-phase construction would never
    // dispose and would leak two instances, failing both assertions below.
    expect(constructCount).toBeGreaterThanOrEqual(1);
    expect(disposeCount).toBeGreaterThanOrEqual(1);
    expect(constructCount - disposeCount).toBe(1);
  });
});

describe("ComposerPage VoiceInstructionRecorder hydration", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  const micButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dictate edit instruction"]',
    );

  beforeEach(() => {
    constructCount = 0;
    disposeCount = 0;
    // Fresh empty store: no generation provider and no capture path, so Voice
    // Edit Mode is unavailable until async RootSideEffects populate the store.
    fakeState = {
      settings: { aiTranscription: { enabled: false } },
      apiKeyById: {},
      userPrefs: { hasProvider: false },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("enables the mic after the store hydrates without recreating the recorder", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(StrictMode, null, createElement(ComposerPage)));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Initially the store is empty, so the mic must be disabled.
    const before = micButton();
    expect(before).not.toBeNull();
    expect(before?.disabled).toBe(true);
    const reasonId = before?.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? "")?.textContent).toContain(
      "Configure a text-generation provider",
    );
    const constructsBeforeHydration = constructCount;

    // Simulate RootSideEffects hydrating the store with a generation provider
    // and a transcription capture path.
    fakeState = {
      settings: { aiTranscription: { enabled: true } },
      apiKeyById: {},
      userPrefs: { hasProvider: true },
    };
    await act(async () => {
      root?.render(
        createElement(StrictMode, null, createElement(ComposerPage)),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // The mic becomes enabled purely from the reactive store update.
    const after = micButton();
    expect(after?.disabled).toBe(false);
    // No new recorder was constructed (and thus no window was reopened) by the
    // hydration re-render — availability is derived live from the store.
    expect(constructCount).toBe(constructsBeforeHydration);
  });
});

describe("ComposerPage review session", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  const mockInvoke = vi.mocked(invoke);

  const transcriptField = () =>
    container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Transcript"] textarea',
    );
  const instructionField = () =>
    container.querySelector<HTMLInputElement>(
      'input[placeholder="Make this shorter or turn it into bullets"]',
    );
  const buttonByText = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    ) ?? null;

  beforeEach(() => {
    constructCount = 0;
    disposeCount = 0;
    fakeState = {
      settings: { aiTranscription: { enabled: false } },
      apiKeyById: {},
      userPrefs: { hasProvider: true },
    };
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "composer_peek_text") return "hello world edited";
      return null;
    });
    window.history.replaceState(
      {},
      "",
      `/?requestId=r1&original=${encodeURIComponent("hello world")}`,
    );
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    mockInvoke.mockReset();
    window.history.replaceState({}, "", "/");
  });

  const renderPage = async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(StrictMode, null, createElement(ComposerPage)));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("marks edited text dirty against the session original", async () => {
    await renderPage();

    expect(transcriptField()?.value).toBe("hello world edited");
    expect(container.textContent).toContain("Unsaved Changes");
    expect(
      container.querySelector(".MuiAccordionDetails-root")?.textContent,
    ).toBe("hello world");
    expect(buttonByText("Undo edit")).toBeNull();
  });

  it("offers Undo after a voice edit and restores the prior text", async () => {
    await renderPage();

    const instruction = instructionField();
    expect(instruction).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(instruction, "Make it formal");
      instruction?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const apply = buttonByText("Apply");
    expect(apply?.disabled).toBe(false);
    await act(async () => {
      apply?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(vi.mocked(applyVoiceEditInstruction)).toHaveBeenCalledWith({
      text: "hello world edited",
      instruction: "Make it formal",
    });
    expect(instructionField()?.value).toBe("");
    expect(container.textContent).not.toContain("Edit failed.");
    expect(transcriptField()?.value).toBe("edited");
    const undo = buttonByText("Undo edit");
    expect(undo).not.toBeNull();
    await act(async () => {
      undo?.click();
      await Promise.resolve();
    });

    expect(transcriptField()?.value).toBe("hello world edited");
    expect(buttonByText("Undo edit")).toBeNull();
  });
});
