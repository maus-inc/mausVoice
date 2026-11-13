// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { theme } from "../../theme";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { resetNativeRecordingSession } from "../../utils/native-recording-session";
import { VoiceInstructionRecorder } from "../composer/voiceInstructionRecorder";
import { MicCheckForm } from "../onboarding/MicCheckForm";
import { MicrophoneTester } from "./MicrophoneTester";

ensureUiHarness();
setMatchMedia(true);

describe("non-dictation microphone local-data clear guards", () => {
  beforeEach(() => {
    resetNativeRecordingSession();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    localStorage.clear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("does not fall back to browser speech recognition when native start_recording rejects for local-data clear", async () => {
    const createSpeechRecognition = vi.fn();
    const onListeningChange = vi.fn();
    const onError = vi.fn();

    const recorder = new VoiceInstructionRecorder({
      invoke: vi
        .fn()
        .mockRejectedValue(new Error("Local data is being cleared")),
      transcribe: vi.fn(),
      getPreferredMicrophone: () => null,
      createSpeechRecognition,
      getLang: () => "en-US",
      canUseProvider: () => true,
      speechRecognitionSupported: true,
      unsupportedMessage: () => "Unsupported",
      recordingUnavailableMessage: () => "Could not start recording",
      onListeningChange,
      onTranscript: vi.fn(),
      onError,
      onResetLevels: vi.fn(),
      logger: { warning: vi.fn() },
    });

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    expect(onListeningChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    recorder.dispose();
  });

  it("aborts an active VoiceInstructionRecorder immediately when local-data clear is requested", async () => {
    let generation = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "recording_generation") {
        generation += 1;
        return Promise.resolve(generation);
      }
      if (command === "start_recording") {
        return Promise.resolve({ sampleRate: 16_000 });
      }
      return Promise.resolve(undefined);
    });
    const onListeningChange = vi.fn();
    const recorder = new VoiceInstructionRecorder({
      invoke,
      transcribe: vi.fn(),
      getPreferredMicrophone: () => null,
      createSpeechRecognition: () => null,
      getLang: () => "en-US",
      canUseProvider: () => true,
      speechRecognitionSupported: false,
      unsupportedMessage: () => "Unsupported",
      recordingUnavailableMessage: () => "Could not start recording",
      onListeningChange,
      onTranscript: vi.fn(),
      onError: vi.fn(),
      onResetLevels: vi.fn(),
      logger: { warning: vi.fn() },
    });

    await recorder.toggle();
    expect(recorder.getState()).toBe("provider");

    const releaseClear = await beginLocalDataClear();
    try {
      expect(recorder.getState()).toBe("idle");
      expect(invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: 1,
      });
      expect(onListeningChange).toHaveBeenLastCalledWith(false);
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
      recorder.dispose();
    }
  });

  it("holds the write lease across MicrophoneTester start_recording and aborts on clear", async () => {
    let resolveStart!: (value: { sampleRate: number }) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "recording_generation") return Promise.resolve(1);
      if (cmd === "start_recording") {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve(new Uint8Array(8));
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let releaseClear: (() => void) | undefined;
    try {
      act(() => {
        root.render(
          createElement(
            IntlProvider,
            { locale: "en", messages: en },
            createElement(
              ThemeProvider,
              { theme },
              createElement(MicrophoneTester, { preferredMicrophone: null }),
            ),
          ),
        );
      });

      const recordBtn = [...host.querySelectorAll("button")].find((btn) =>
        btn.textContent?.includes("Record"),
      );
      act(() => {
        recordBtn?.click();
      });
      // The admission is requested first, so the microphone open is dispatched
      // one microtask later.
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("start_recording", {
          ownerId: expect.any(String),
          generation: 1,
          args: { preferredMicrophone: null },
        }),
      );

      let clearPromise!: Promise<() => void>;
      act(() => {
        clearPromise = beginLocalDataClear();
      });

      await act(async () => {
        resolveStart({ sampleRate: 16_000 });
        releaseClear = await clearPromise;
      });

      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "stop_recording"),
      ).toBe(true);
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear?.();
      act(() => root.unmount());
      host.remove();
    }
  });

  it("blocks MicCheckForm from starting native recording while local-data clear is active", async () => {
    const releaseClear = await beginLocalDataClear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(
              IntlProvider,
              { locale: "en", messages: en },
              createElement(
                ThemeProvider,
                { theme },
                createElement(MicCheckForm),
              ),
            ),
          ),
        );
      });
      expect(invokeMock).not.toHaveBeenCalledWith(
        "start_recording",
        expect.anything(),
      );
    } finally {
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
      act(() => root.unmount());
      host.remove();
    }
  });
});
