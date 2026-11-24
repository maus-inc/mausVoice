// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement, type ReactElement } from "react";
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
import { MicCheckForm } from "../onboarding/MicCheckForm";
import { MicrophoneTester } from "./MicrophoneTester";

ensureUiHarness();
setMatchMedia(true);

type Call = [string, { generation?: number } | undefined];

const endCallsFor = (generation: number, command: string): Call[] =>
  (invokeMock.mock.calls as Call[]).filter(
    ([cmd, args]) => cmd === command && args?.generation === generation,
  );

/** Start a capture, stop it through a local-data clear while the reply is
 * pending, then let the late reply land. Returns the generation it used. */
const stopDuringOpeningWindow = async (
  element: ReactElement,
  stop: () => Promise<unknown>,
) => {
  let resolveStart!: (value: { sampleRate: number }) => void;
  invokeMock.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    if (command === "start_recording")
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    if (command === "stop_recording") return stop();
    return Promise.resolve(undefined);
  });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let releaseClear: (() => void) | undefined;
  try {
    act(() => root.render(element));

    const recordButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Record"),
    );
    act(() => recordButton?.click());
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "start_recording",
        expect.objectContaining({ generation: 1 }),
      ),
    );

    let clearPromise!: Promise<() => void>;
    await act(async () => {
      clearPromise = beginLocalDataClear();
      await vi.waitFor(() =>
        expect(endCallsFor(1, "stop_recording")).toHaveLength(1),
      );
    });

    await act(async () => {
      resolveStart({ sampleRate: 16_000 });
      releaseClear = await clearPromise;
      await Promise.resolve();
    });
  } finally {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    releaseClear?.();
    act(() => root.unmount());
    host.remove();
  }
};

const surfaces: [string, () => ReactElement][] = [
  [
    "MicrophoneTester",
    () =>
      createElement(
        IntlProvider,
        { locale: "en", messages: en },
        createElement(
          ThemeProvider,
          { theme },
          createElement(MicrophoneTester, { preferredMicrophone: null }),
        ),
      ),
  ],
  [
    "MicCheckForm",
    () =>
      createElement(
        MemoryRouter,
        null,
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(ThemeProvider, { theme }, createElement(MicCheckForm)),
        ),
      ),
  ],
];

/** Settle a capture, then press the surface's stop control while the stop
 * command rejects. Returns the generation the surface recorded under. */
const stopAfterSettledCapture = async (
  element: ReactElement,
  stopLabel: string,
  stop: () => Promise<unknown>,
) => {
  invokeMock.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    if (command === "start_recording")
      return Promise.resolve({ sampleRate: 16_000 });
    if (command === "stop_recording") return stop();
    return Promise.resolve(undefined);
  });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(element));

    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes(label),
      );

    act(() => button("Record")?.click());
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "start_recording",
        expect.objectContaining({ generation: 1 }),
      ),
    );

    await act(async () => {
      button(stopLabel)?.click();
      await Promise.resolve();
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
};

const stoppableSurfaces: [string, () => ReactElement, string][] = [
  ["MicrophoneTester", surfaces[0][1], "Finish"],
  ["MicCheckForm", surfaces[1][1], "Looks good"],
];

describe("a stop that fails on a settled capture", () => {
  beforeEach(() => {
    resetNativeRecordingSession();
    invokeMock.mockReset();
    localStorage.clear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it.each(stoppableSurfaces)(
    "%s releases the capture its failed stop left open",
    async (_name, element, stopLabel) => {
      await stopAfterSettledCapture(element(), stopLabel, () =>
        Promise.reject(new Error("device did not stop")),
      );

      await vi.waitFor(() =>
        expect(endCallsFor(1, "discard_recording")).toHaveLength(1),
      );
    },
  );

  it.each(stoppableSurfaces)(
    "%s leaves a capture that stopped cleanly alone",
    async (_name, element, stopLabel) => {
      await stopAfterSettledCapture(element(), stopLabel, () =>
        Promise.resolve({ samples: [], sampleRate: 16_000 }),
      );

      expect(endCallsFor(1, "discard_recording")).toEqual([]);
    },
  );
});

describe("a stop that fails during the opening window", () => {
  beforeEach(() => {
    resetNativeRecordingSession();
    invokeMock.mockReset();
    localStorage.clear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it.each(surfaces)(
    "%s discards the admitted capture the failed stop left open",
    async (_name, element) => {
      await stopDuringOpeningWindow(element(), () =>
        Promise.reject(new Error("device did not stop")),
      );

      await vi.waitFor(() =>
        expect(endCallsFor(1, "discard_recording")).toHaveLength(1),
      );
    },
  );

  it.each(surfaces)(
    "%s leaves a capture that stopped cleanly alone",
    async (_name, element) => {
      await stopDuringOpeningWindow(element(), () =>
        Promise.resolve({ samples: [], sampleRate: 16_000 }),
      );

      expect(endCallsFor(1, "discard_recording")).toEqual([]);
    },
  );
});
