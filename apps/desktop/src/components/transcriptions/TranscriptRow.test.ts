// @vitest-environment jsdom
import {
  openContextMenu,
  menuLabels,
} from "../../../test/helpers/context-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { setMatchMedia as stubMatchMedia } from "../../../test/helpers/jsdom-ui-harness";
import { createRoot } from "react-dom/client";
import type { Transcription } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { ThemeProvider } from "@mui/material/styles";
import { theme } from "../../theme";

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
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
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

describe("TranscriptionRow retranscribe button states", () => {
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
      button?.querySelector('[data-testid="retranscribe-replay"]'),
    ).not.toBeNull();
  });
});

describe("TranscriptionRow unified hover region", () => {
  /** CSS blocks whose selector carries one of the element's classes at :hover. */
  const hoverRulesFor = (el: Element): string => {
    const text = Array.from(document.querySelectorAll("style"))
      .map((node) => node.textContent ?? "")
      .join("\n");
    const rules: string[] = [];
    for (const cls of el.classList) {
      for (const match of text.matchAll(
        new RegExp(`\\.${cls}[^{}]*:hover\\{[^}]*\\}`, "g"),
      )) {
        rules.push(match[0]);
      }
    }
    return rules.join("\n");
  };

  it("covers the whole item — date row, transcript, audio pill — never the date column alone", async () => {
    // Themed render so the hover wash serializes through the css-var tokens.
    const themeRoot = createRoot(container);
    root = themeRoot;
    await act(async () => {
      themeRoot.render(
        createElement(
          ThemeProvider,
          { theme },
          createElement(TranscriptionRow, { id: "row-1" }),
        ),
      );
    });

    const dateEl = container.querySelector(".MuiTypography-subtitle2");
    expect(dateEl).not.toBeNull();
    // Visible transcript copy; the hidden measuring copy is aria-hidden.
    const transcriptEl = Array.from(
      container.querySelectorAll<HTMLElement>(".MuiTypography-body2"),
    ).find((el) => el.closest("[aria-hidden]") === null);
    expect(transcriptEl).not.toBeUndefined();

    // The hover owner is the ancestor whose :hover rule paints the theme's
    // action.hover wash.
    let hoverOwner: HTMLElement | null = null;
    for (
      let node: HTMLElement | null = transcriptEl!;
      node && node !== container;
      node = node.parentElement
    ) {
      if (hoverRulesFor(node).includes("action-hover")) {
        hoverOwner = node;
        break;
      }
    }

    expect(hoverOwner).not.toBeNull();
    expect(hoverOwner!.contains(dateEl)).toBe(true);
    expect(hoverOwner!.contains(transcriptEl!)).toBe(true);
    // Audio pill actions (retranscribe/export) sit inside the wash too.
    expect(hoverOwner!.contains(retranscribeButton(container))).toBe(true);
    // The divider stays outside the wash so rows keep a clean seam.
    const divider = container.querySelector("hr");
    expect(divider).not.toBeNull();
    expect(hoverOwner!.contains(divider)).toBe(false);
    // Regression pin: the date/actions row itself must not own the hover.
    const dateStack = dateEl!.closest(".MuiStack-root") as HTMLElement;
    expect(hoverRulesFor(dateStack)).not.toContain("action-hover");
  });
});

describe("TranscriptionRow context menu", () => {
  const openMenu = async () => {
    root = await renderRow(container);
    return openContextMenu(container);
  };

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
