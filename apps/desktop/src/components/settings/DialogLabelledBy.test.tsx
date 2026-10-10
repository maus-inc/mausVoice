// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

// The heavy children are not what this file is about: each one would drag in
// its own repo and IPC surface, and the assertion only reads the `Dialog` and
// the title it is labelled by.
vi.mock("./AIPostProcessingConfiguration", () => ({
  AIPostProcessingConfiguration: () => null,
}));
vi.mock("./AIAgentModeConfiguration", () => ({
  AIAgentModeConfiguration: () => null,
}));
vi.mock("./HotkeySetting", () => ({ HotkeySetting: () => null }));
vi.mock("../../actions/transcriptions.actions", () => ({
  importAudioFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../transcriptions/TranscriptionsSideEffects", () => ({
  TranscriptionsSideEffects: () => null,
}));
vi.mock("../onboarding/TipCard", () => ({
  TipCard: () => null,
  useTip: () => false,
}));
vi.mock("../transcriptions/TranscriptRow", () => ({
  TranscriptionRow: () => null,
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

import { AIAgentModeDialog } from "./AIAgentModeDialog";
import { AIPostProcessingDialog } from "./AIPostProcessingDialog";
import TranscriptionsPage from "../transcriptions/TranscriptionsPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

/**
 * MUI renders the dialog into a portal, so it is looked up on `document.body`
 * rather than in the container. An unnamed dialog announces nothing useful to
 * a screen reader, so the assertion is that `aria-labelledby` resolves to an
 * element holding the visible title.
 */
const accessibleNameOf = (): string | null => {
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  const labelledBy = dialog?.getAttribute("aria-labelledby");
  if (!dialog || !labelledBy) return null;
  return document.getElementById(labelledBy)?.textContent ?? null;
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  resetState();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = "";
  resetState();
});

const render = async (node: ReactNode) => {
  await act(async () => {
    root?.render(node);
  });
};

describe("settings dialogs announce their title", () => {
  it("names the AI post-processing dialog", async () => {
    produceAppState((draft) => {
      draft.settings.aiPostProcessingDialogOpen = true;
    });

    await render(createElement(AIPostProcessingDialog));

    expect(accessibleNameOf()).toBe("AI post processing");
  });

  it("names the assistant-mode dialog", async () => {
    produceAppState((draft) => {
      draft.settings.agentModeDialogOpen = true;
    });

    await render(createElement(AIAgentModeDialog));

    expect(accessibleNameOf()).toBe("Assistant modeBeta");
  });

  it("names the import-audio dialog on the transcriptions page", async () => {
    await render(createElement(TranscriptionsPage));

    const openImport = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Import audio");
    if (!openImport) throw new Error("Import audio button must be rendered");
    await act(async () => {
      openImport.click();
    });

    expect(accessibleNameOf()).toBe("Import audio");
  });
});
