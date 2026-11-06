// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Tracks VoiceInstructionRecorder construction/disposal so we can prove the
// recorder is built inside an effect — exactly one live instance under
// StrictMode's mount → cleanup → remount cycle — rather than during render,
// which would leak an undisposed instance on StrictMode's double render.
const logger = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));

let constructCount = 0;
let disposeCount = 0;
let recorderDeps: { onResetLevels: () => void } | undefined;
let storeDraft: Record<string, unknown> = {};

vi.mock("./voiceInstructionRecorder", () => ({
  VoiceInstructionRecorder: class {
    constructor(deps: { onResetLevels: () => void }) {
      recorderDeps = deps;
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
  getLogger: () => logger,
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
  produceAppState: (fn: (draft: Record<string, unknown>) => void) =>
    fn(storeDraft),
}));

import { ComposerPage } from "./ComposerPage";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { invoke } from "@tauri-apps/api/core";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setupComposerContainer = (): HTMLDivElement => {
  constructCount = 0;
  disposeCount = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
};

const mountComposerPage = async (
  container: HTMLDivElement,
): Promise<ReturnType<typeof createRoot>> => {
  let mounted: ReturnType<typeof createRoot> | null = null;
  await act(async () => {
    mounted = createRoot(container);
    mounted.render(
      createElement(StrictMode, null, createElement(ComposerPage)),
    );
  });
  // Let the StrictMode mount, cleanup, remount cycle and microtasks settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!mounted) throw new Error("composer root did not mount");
  return mounted;
};

const teardownComposerContainer = (
  root: ReturnType<typeof createRoot> | null,
  container: HTMLDivElement,
): void => {
  act(() => {
    root?.unmount();
  });
  container.remove();
};

describe("ComposerPage VoiceInstructionRecorder lifecycle", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = setupComposerContainer();
  });

  afterEach(() => {
    teardownComposerContainer(root, container);
    root = null;
  });

  it.each(["recording", "loading", "paused"])(
    "does not erase a newer %s dictation waveform after transcription",
    async (phase) => {
      root = await mountComposerPage(container);
      storeDraft = { overlayPhase: phase, audioLevels: [0.75] };
      expect(recorderDeps).toBeDefined();
      recorderDeps?.onResetLevels();
      expect(storeDraft.audioLevels).toEqual([0.75]);
    },
  );

  it("clears the voice-edit waveform when the global recorder is idle", async () => {
    root = await mountComposerPage(container);
    storeDraft = { overlayPhase: "idle", audioLevels: [0.75] };
    recorderDeps?.onResetLevels();
    expect(storeDraft.audioLevels).toEqual([]);
  });

  it("builds exactly one live recorder under StrictMode (no render-phase leak)", async () => {
    root = await mountComposerPage(container);

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
    // Fresh empty store: no generation provider and no capture path, so Voice
    // Edit Mode is unavailable until async RootSideEffects populate the store.
    fakeState = {
      settings: { aiTranscription: { enabled: false } },
      apiKeyById: {},
      userPrefs: { hasProvider: false },
    };
    container = setupComposerContainer();
  });

  afterEach(() => {
    teardownComposerContainer(root, container);
    root = null;
  });

  it("enables the mic after the store hydrates without recreating the recorder", async () => {
    root = await mountComposerPage(container);

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
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      const requestId =
        args && typeof args === "object" && "requestId" in args
          ? args.requestId
          : undefined;
      return Promise.resolve(
        command === "composer_peek_text"
          ? requestId === "r1:original"
            ? "hello world"
            : "hello world edited"
          : null,
      );
    });
    window.history.replaceState({}, "", "/?requestId=r1");
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

  it("does not overwrite user edits when the initial transcript arrives late", async () => {
    let finishPeek: (text: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      finishPeek = resolve;
    });
    mockInvoke.mockImplementation((command: string) =>
      command === "composer_peek_text" ? pending : Promise.resolve(null),
    );
    await renderPage();
    const field = transcriptField()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, "my text");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      finishPeek("late original");
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("my text");
  });

  it("marks edited text dirty against the session original", async () => {
    await renderPage();

    expect(transcriptField()?.value).toBe("hello world edited");
    expect(container.textContent).toContain("Unsaved Changes");
    expect(
      container.querySelector(".MuiAccordionDetails-root")?.textContent,
    ).toBe("hello world");
    expect(buttonByText("Undo edit")).toBeNull();
  });

  const enterInstruction = async (value: string) => {
    const instruction = instructionField();
    expect(instruction).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(instruction, value);
      instruction?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("applies an instruction on Ctrl+Enter", async () => {
    await renderPage();
    await enterInstruction("Make it formal");
    await act(async () => {
      instructionField()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(vi.mocked(applyVoiceEditInstruction)).toHaveBeenCalledWith({
      text: "hello world edited",
      instruction: "Make it formal",
    });
  });

  it("offers Undo after a voice edit and restores the prior text", async () => {
    await renderPage();

    await enterInstruction("Make it formal");

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

  it("disables Undo while another edit is pending, then restores that edit's input", async () => {
    await renderPage();
    await enterInstruction("Make it formal");
    await act(async () => {
      buttonByText("Apply")?.click();
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("edited");

    let finishEdit: (value: string) => void = () => undefined;
    vi.mocked(applyVoiceEditInstruction).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishEdit = resolve;
      }),
    );
    await enterInstruction("Make it shorter");
    await act(async () => {
      buttonByText("Apply")?.click();
      await Promise.resolve();
    });
    expect(buttonByText("Undo edit")?.disabled).toBe(true);
    await act(async () => buttonByText("Undo edit")?.click());
    expect(transcriptField()?.value).toBe("edited");
    await act(async () => {
      finishEdit("second edit");
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("second edit");
    expect(buttonByText("Undo edit")?.disabled).toBe(false);
    await act(async () => buttonByText("Undo edit")?.click());
    expect(transcriptField()?.value).toBe("edited");
  });

  it("starts at most one edit for two clicks in the same React batch", async () => {
    await renderPage();
    let finishEdit: (value: string) => void = () => undefined;
    vi.mocked(applyVoiceEditInstruction)
      .mockClear()
      .mockReturnValueOnce(
        new Promise<string>((resolve) => {
          finishEdit = resolve;
        }),
      );
    await enterInstruction("Make it formal");
    const button = buttonByText("Apply")!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(applyVoiceEditInstruction).toHaveBeenCalledOnce();
    await act(async () => {
      finishEdit("formal");
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("formal");
  });

  it("releases the edit latch after a failed request so the user can retry", async () => {
    await renderPage();
    vi.mocked(applyVoiceEditInstruction)
      .mockClear()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("retried edit");
    await enterInstruction("Make it formal");
    await act(async () => {
      buttonByText("Apply")?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("provider unavailable");
    expect(buttonByText("Apply")?.disabled).toBe(false);
    await act(async () => {
      buttonByText("Apply")?.click();
      await Promise.resolve();
    });
    expect(applyVoiceEditInstruction).toHaveBeenCalledTimes(2);
    expect(transcriptField()?.value).toBe("retried edit");
  });

  it("does not install a stale AI edit or undo point after the transcript changes", async () => {
    await renderPage();
    let finishEdit: (value: string) => void = () => undefined;
    vi.mocked(applyVoiceEditInstruction).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishEdit = resolve;
      }),
    );
    await enterInstruction("Make it formal");
    await act(async () => {
      buttonByText("Apply")?.click();
    });
    const field = transcriptField()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(field, "new manual text");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      finishEdit("stale result");
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("new manual text");
    expect(buttonByText("Undo edit")).toBeNull();
  });

  it("does not erase a new instruction typed while an edit is pending", async () => {
    await renderPage();
    let finishEdit: (value: string) => void = () => undefined;
    vi.mocked(applyVoiceEditInstruction).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishEdit = resolve;
      }),
    );
    await enterInstruction("Make it formal");
    await act(async () => {
      buttonByText("Apply")?.click();
    });
    await enterInstruction("Make it shorter next");
    await act(async () => {
      finishEdit("formal text");
      await Promise.resolve();
    });
    expect(transcriptField()?.value).toBe("formal text");
    expect(instructionField()?.value).toBe("Make it shorter next");
  });

  it("inserts the current transcript and cancels with Escape", async () => {
    await renderPage();
    const { emit } = await import("@tauri-apps/api/event");
    const emitMock = vi.mocked(emit);
    emitMock.mockClear();
    await act(async () => {
      buttonByText("Insert")?.click();
      await Promise.resolve();
    });
    expect(emitMock).toHaveBeenCalledWith("composer-result", {
      requestId: "r1",
      accepted: true,
      text: "hello world edited",
    });
    emitMock.mockClear();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(emitMock).toHaveBeenCalledWith("composer-result", {
      requestId: "r1",
      accepted: false,
      text: "",
    });
  });

  it("reports a failed composer result without logging the submitted content", async () => {
    root = await mountComposerPage(container);
    const { emit } = await import("@tauri-apps/api/event");
    vi.mocked(emit).mockRejectedValueOnce(
      new Error("private submitted transcript"),
    );
    logger.error.mockClear();
    await act(async () => {
      buttonByText("Cancel")?.click();
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "Failed to emit composer result",
    );
    expect(container.textContent).toContain("private submitted transcript");
  });
});
