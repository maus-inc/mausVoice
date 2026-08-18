// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act } from "react-dom/test-utils";
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

vi.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
}));

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
  getTranscribeAudioRepo: () => ({ repo: {} }),
  getGenerateTextRepo: () => ({ repo: {} }),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn() }),
}));
vi.mock("../../utils/user.utils", () => ({
  getMyPreferredMicrophone: () => null,
}));

const fakeState = {
  settings: { aiTranscription: {} },
  apiKeyById: {},
  userPrefs: {},
};
vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(fakeState),
  getAppState: () => fakeState,
  produceAppState: (fn: (draft: Record<string, unknown>) => void) => fn({}),
}));

import { ComposerPage } from "./ComposerPage";

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
