// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const h = vi.hoisted(() => ({
  deleteTranscription: vi.fn(),
  scheduleTranscriptionDelete: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: vi.fn(async () => null),
  };
});

vi.mock("../../actions/remote-output.actions", () => ({
  sendTextToActiveRemoteTarget: vi.fn(),
}));

vi.mock("../../repos", () => ({
  getTranscriptionRepo: () => ({
    deleteTranscription: h.deleteTranscription,
  }),
}));

vi.mock("../../utils/pending-transcription-delete", () => ({
  scheduleTranscriptionDelete: h.scheduleTranscriptionDelete,
  undoTranscriptionDelete: vi.fn(),
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

vi.mock("./AudioPlayerPill", () => ({
  AudioPlayerPill: ({
    actions,
  }: {
    actions: ReturnType<typeof createElement>;
  }) => actions,
}));

import { TranscriptionRow } from "./TranscriptRow";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sampleTranscription: Transcription = {
  id: "row-1",
  createdAt: "2026-08-01T12:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "hello world",
  isDeleted: false,
  audio: { filePath: "/tmp/row-1.wav", durationMs: 1500 },
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const seedRow = () => {
  produceAppState((draft) => {
    draft.transcriptionById["row-1"] = sampleTranscription;
    draft.transcriptions.transcriptionIds = ["row-1"];
  });
};

const stubMatchMedia = (matches: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
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

const renderRow = async (container: HTMLElement) => {
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(TranscriptionRow, { id: "row-1" }),
      ),
    );
  });
  return root;
};

const retranscribeButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    "button[aria-label='Retranscribe audio clip'], button[aria-label='Retranscribing audio clip'], button[aria-label='Retranscribed audio clip']",
  );

describe("TranscriptionRow retranscribe button states", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    seedRow();
    container = document.createElement("div");
    document.body.appendChild(container);
    stubMatchMedia(false);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    resetState();
  });

  it("renders a spinner and disables the button while the row is in flight", async () => {
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds.push("row-1");
    });
    root = await renderRow(container);

    const button = retranscribeButton(container);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe(
      "Retranscribing audio clip",
    );
    expect(button?.querySelector(".MuiCircularProgress-root")).not.toBeNull();
    expect(
      button?.querySelector('[data-testid="retranscribe-hourglass"]'),
    ).toBeNull();
  });

  it("renders a static hourglass instead of a spinner when motion is reduced", async () => {
    stubMatchMedia(true);
    produceAppState((draft) => {
      draft.transcriptions.retranscribingIds.push("row-1");
    });
    root = await renderRow(container);

    const button = retranscribeButton(container);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.querySelector(".MuiCircularProgress-root")).toBeNull();
    expect(
      button?.querySelector('[data-testid="retranscribe-hourglass"]'),
    ).not.toBeNull();
  });

  it("renders a checkmark while the row is in the completed set", async () => {
    produceAppState((draft) => {
      draft.transcriptions.retranscriptionSuccessIds.push("row-1");
    });
    root = await renderRow(container);

    const button = retranscribeButton(container);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-busy")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Retranscribed audio clip");
    expect(
      button?.querySelector('[data-testid="retranscribe-check"]'),
    ).not.toBeNull();
  });

  it("renders the replay icon when the row is idle", async () => {
    root = await renderRow(container);

    const button = retranscribeButton(container);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Retranscribe audio clip");
    expect(
      button?.querySelector('[data-testid="ReplayRoundedIcon"]'),
    ).not.toBeNull();
  });
});

describe("TranscriptionRow context menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    seedRow();
    container = document.createElement("div");
    document.body.appendChild(container);
    stubMatchMedia(false);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    resetState();
  });

  const openMenu = async () => {
    root = await renderRow(container);
    const row = container.querySelector<HTMLElement>("div");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    act(() => {
      row?.dispatchEvent(event);
    });
    return document.querySelector('[role="menu"]');
  };

  const menuLabels = (menu: Element | null): string[] =>
    Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map(
      (el) => el.textContent ?? "",
    );

  it("opens a context menu with common verbs first and Delete last", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    expect(menuLabels(menu)).toEqual([
      "Copy text",
      "Copy ID",
      "Open details",
      "Retranscribe",
      "Delete",
    ]);
    // Divider sits between Retranscribe and Delete.
    expect(menu?.querySelector("hr")).not.toBeNull();
    const items = menu?.querySelectorAll('[role="menuitem"]') ?? [];
    expect(items[items.length - 1].textContent).toBe("Delete");
  });

  it("deletes the transcription when the Delete item is clicked", async () => {
    const menu = await openMenu();
    const deleteItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Delete") as HTMLElement | undefined;
    expect(deleteItem).toBeTruthy();

    await act(async () => {
      deleteItem?.click();
    });

    expect(h.scheduleTranscriptionDelete).toHaveBeenCalledWith(
      sampleTranscription,
      5000,
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
