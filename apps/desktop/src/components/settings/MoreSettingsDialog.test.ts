// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

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

import { MoreSettingsDialog } from "./MoreSettingsDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MoreSettingsDialog spoken-command guidance", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((draft) => {
      draft.settings.moreSettingsDialogOpen = true;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("explains that Auto applies the English spoken-command grammar", async () => {
    await act(async () => {
      root?.render(createElement(MoreSettingsDialog));
    });

    expect(document.body.textContent).toContain(
      "Commands apply for English or Auto dictation.",
    );
    expect(document.body.textContent).not.toContain(
      "Auto does not apply these commands.",
    );
  });

  it("exposes the failed-transcription audio retention setting", async () => {
    await act(async () => {
      root?.render(createElement(MoreSettingsDialog));
    });

    expect(document.body.textContent).toContain("Preserve audio on failure");
    expect(document.body.textContent).toContain(
      "Keep the audio snapshot with a failed transcription",
    );
  });
});
