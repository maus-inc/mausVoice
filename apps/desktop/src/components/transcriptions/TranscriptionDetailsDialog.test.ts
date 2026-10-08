// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Transcription } from "@maus-inc/types";
import { POST_PROCESS_ERROR_CATEGORY } from "../../actions/post-process-error-category";
import { POST_PROCESS_TRUNCATED_WARNING } from "../../utils/prompt.utils";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { setMatchMedia } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: vi.fn(() => Promise.resolve(null)) };
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

const stubMatchMedia = () => setMatchMedia(false);

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
      "API key",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Small");
    expect(text).toContain("Metal");
    expect(text).toContain("1.50s");
    expect(text).toContain("250ms");
    expect(text).toContain("openai/gpt-oss-20b");
  });

  it("renders failed provider categories as localized warning feedback", async () => {
    seed({
      warnings: [POST_PROCESS_ERROR_CATEGORY.providerLimit],
      postProcessFailed: true,
      postProcessFallback: false,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
    });
    root = await render(container);

    expect(bodyText()).toContain(
      "Styling failed because the provider request or usage limit was reached.",
    );
    expect(bodyText()).not.toContain(POST_PROCESS_ERROR_CATEGORY.providerLimit);
  });

  it("does not describe a successful local fallback as a total failure", async () => {
    seed({
      warnings: [POST_PROCESS_ERROR_CATEGORY.providerLimit],
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
    });
    root = await render(container);

    expect(bodyText()).toContain(
      "Online styling failed because the provider request or usage limit was reached. Your local style was applied instead.",
    );
    expect(bodyText()).not.toContain("Styling failed because");
  });

  it("describes a raw unusable-response marker instead of showing it verbatim", async () => {
    seed({
      warnings: [POST_PROCESS_TRUNCATED_WARNING],
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: null,
    });
    root = await render(container);

    expect(bodyText()).toContain(
      "The incomplete styling reply was discarded at the model's output limit. The previous text was kept.",
    );
    expect(bodyText()).not.toContain(POST_PROCESS_TRUNCATED_WARNING);
  });

  it("refreshes warning feedback when outcome metadata changes but warnings do not", async () => {
    const warnings = [POST_PROCESS_ERROR_CATEGORY.providerLimit];
    seed({
      warnings,
      postProcessFailed: false,
      postProcessFallback: true,
      postProcessError: POST_PROCESS_ERROR_CATEGORY.providerLimit,
    });
    root = await render(container);

    expect(bodyText()).toContain("Your local style was applied instead.");
    const storedWarnings = getAppState().transcriptionById["t-1"]?.warnings;

    act(() => {
      produceAppState((draft) => {
        const transcription = draft.transcriptionById["t-1"];
        if (!transcription)
          throw new Error("Transcription missing from test state");
        transcription.postProcessFailed = true;
        transcription.postProcessFallback = false;
      });
    });

    expect(getAppState().transcriptionById["t-1"]?.warnings).toBe(
      storedWarnings,
    );
    expect(bodyText()).toContain(
      "Styling failed because the provider request or usage limit was reached.",
    );
    expect(bodyText()).not.toContain("Your local style was applied instead.");
  });
});
