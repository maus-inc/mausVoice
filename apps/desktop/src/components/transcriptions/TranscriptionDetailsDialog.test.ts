// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(async () => null) };
});

vi.mock("../../repos", () => ({
  getTranscriptionRepo: () => ({}),
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

import { TranscriptionDetailsDialog } from "./TranscriptionDetailsDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseTranscription: Transcription = {
  id: "t-1",
  createdAt: "2026-08-01T12:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "hello world",
  isDeleted: false,
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const seed = (overrides: Partial<Transcription>) => {
  produceAppState((draft) => {
    draft.transcriptionById["t-1"] = { ...baseTranscription, ...overrides };
    draft.transcriptions.transcriptionIds = ["t-1"];
    draft.transcriptions.detailsDialogTranscriptionId = "t-1";
    draft.transcriptions.detailsDialogOpen = true;
  });
};

const stubMatchMedia = () => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
};

const render = async (container: HTMLElement) => {
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(TranscriptionDetailsDialog));
  });
  return root;
};

// The dialog renders into a portal, so assert against the whole document.
const bodyText = () => document.body.textContent ?? "";

describe("TranscriptionDetailsDialog post-processing model field", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    container = document.createElement("div");
    document.body.appendChild(container);
    stubMatchMedia();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    resetState();
  });

  it("renders the persisted post-processing model", async () => {
    seed({
      postProcessMode: "api",
      postProcessDevice: "API • Groq",
      postProcessModel: "openai/gpt-oss-20b",
    });
    root = await render(container);

    expect(bodyText()).toContain("openai/gpt-oss-20b");
  });

  it("falls back to Unknown when no model is persisted", async () => {
    seed({
      postProcessMode: "api",
      postProcessDevice: "API • Groq",
      postProcessModel: null,
    });
    root = await render(container);

    expect(bodyText()).toContain("Model");
    expect(bodyText()).toContain("Unknown");
  });

  it("still renders every metadata field after the DetailField refactor", async () => {
    seed({
      modelSize: "small",
      inferenceDevice: "Metal",
      transcriptionMode: "local",
      postProcessMode: "api",
      postProcessDevice: "API \u2022 Groq",
      postProcessModel: "openai/gpt-oss-20b",
      transcriptionDurationMs: 1500,
      postprocessDurationMs: 250,
    });
    root = await render(container);

    const text = bodyText();
    for (const label of [
      "Transcription Duration",
      "Post-processing Duration",
      "Device",
      "Model Size",
      "Processor",
      "Model",
      "API Key",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Small");
    expect(text).toContain("Metal");
    expect(text).toContain("1.50s");
    expect(text).toContain("250ms");
    expect(text).toContain("openai/gpt-oss-20b");
  });
});
