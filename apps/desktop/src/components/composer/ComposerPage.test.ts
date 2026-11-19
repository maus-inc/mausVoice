// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { VoiceInstructionRecorderDeps } from "./voiceInstructionRecorder";
import { encodeRecordedAudio } from "../../utils/recorded-audio.utils";

// Tracks VoiceInstructionRecorder construction/disposal so we can prove the
// recorder is built inside an effect — exactly one live instance under
// StrictMode's mount → cleanup → remount cycle — rather than during render,
// which would leak an undisposed instance on StrictMode's double render.
const logger = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));

let constructCount = 0;
let disposeCount = 0;

vi.mock("./voiceInstructionRecorder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./voiceInstructionRecorder")>();
  return {
    ...actual,
    VoiceInstructionRecorder: class extends actual.VoiceInstructionRecorder {
      constructor(deps: VoiceInstructionRecorderDeps) {
        super(deps);
        constructCount++;
      }
      override dispose() {
        super.dispose();
        disposeCount++;
      }
    },
  };
});

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
  produceAppState: (fn: (draft: Record<string, unknown>) => void) => fn({}),
}));

import { ComposerPage } from "./ComposerPage";
import { transcribeAudio } from "../../actions/transcribe.actions";
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
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "composer_peek_text" ? "hello world edited" : null,
      ),
    );
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

  const enableProviderMic = (
    stopReply: (generation: unknown) => Promise<unknown>,
  ) => {
    fakeState.settings.aiTranscription.enabled = true;
    let generation = 0;
    mockInvoke.mockImplementation((command, args) => {
      if (command === "recording_generation")
        return Promise.resolve(++generation);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16_000 });
      if (command === "stop_recording" && args && "generation" in args)
        return stopReply(args.generation);
      return Promise.resolve(null);
    });
  };

  const clickMic = async () => {
    const mic = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dictate edit instruction"]',
    );
    if (!mic || mic.disabled)
      throw new Error("Expected an enabled instruction microphone");
    await act(() => mic.click());
  };

  it("puts the replacement recording's words in the instruction field after the old transcription rejects", async () => {
    enableProviderMic((generation) => {
      expect([1, 2]).toContain(generation);
      return Promise.resolve(
        encodeRecordedAudio([generation === 1 ? 0.25 : 0.75], 16_000),
      );
    });
    let rejectOld!: (error: Error) => void;
    const old = new Promise<never>((_, reject) => {
      rejectOld = reject;
    });
    const transcribe = vi.mocked(transcribeAudio);
    transcribe.mockClear().mockImplementation(({ samples, sampleRate }) => {
      expect(sampleRate).toBe(16_000);
      if (!samples) throw new Error("Expected a recorded sample");
      if (samples[0] === 0.25) return old;
      expect(Array.from(samples)).toEqual([0.75]);
      return Promise.resolve({
        rawTranscript: "new words",
        sanitizedTranscript: "new words",
        warnings: [],
        metadata: {},
      });
    });
    root = await mountComposerPage(container);
    await clickMic();
    await clickMic();
    expect(transcribe).toHaveBeenCalledExactlyOnceWith({
      samples: Float32Array.of(0.25),
      sampleRate: 16_000,
    });
    act(() => root?.unmount());
    root = await mountComposerPage(container);
    await clickMic();
    expect(mockInvoke).toHaveBeenCalledWith(
      "start_recording",
      expect.objectContaining({ generation: 2 }),
    );
    await act(() => rejectOld(new Error("old transcription failed")));
    await clickMic();
    expect(instructionField()?.value).toBe("new words");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("reports a native stop failure as a stop failure", async () => {
    enableProviderMic(() => Promise.reject(new Error("private device detail")));
    root = await mountComposerPage(container);
    await clickMic();
    await clickMic();
    expect(container.textContent).toContain("Failed to stop recording");
    expect(container.textContent).not.toContain("private device detail");
    expect(mockInvoke).toHaveBeenCalledWith(
      "discard_recording",
      expect.objectContaining({ generation: 1 }),
    );
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
