// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Tone } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: vi.fn(async () => null),
  };
});

vi.mock("../../actions/tone.actions", () => ({
  openToneEditorDialog: vi.fn(),
  deleteTone: vi.fn(),
}));

vi.mock("../common/ListTile", () => ({
  ListTile: () => createElement("div", null),
}));

vi.mock("../common/MenuPopover", () => ({
  MenuPopoverBuilder: () => null,
  MenuPopoverItem: {} as never,
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

import { ManualStylingRow } from "./ManualStylingRow";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const seedRow = () => {
  produceAppState((draft) => {
    draft.toneById["tone-1"] = {
      id: "tone-1",
      name: "Formal",
      description: "",
      promptTemplate: "Write formally.",
      isSystem: false,
      isGlobal: false,
    } as unknown as Tone;
  });
};

describe("ManualStylingRow context menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    seedRow();
    container = document.createElement("div");
    document.body.appendChild(container);
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
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(ManualStylingRow, { id: "tone-1" }),
        ),
      );
    });
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

  it("opens a context menu with Edit first and Delete last (danger)", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    expect(menuLabels(menu)).toEqual(["Edit", "View full prompt", "Delete"]);
    expect(menu?.querySelector("hr")).not.toBeNull();
    const items = menu?.querySelectorAll('[role="menuitem"]') ?? [];
    expect(items[items.length - 1].textContent).toBe("Delete");
  });

  it("does not expose Edit or Delete for an organization-managed style", async () => {
    produceAppState((draft) => {
      draft.toneById["tone-1"].isGlobal = true;
    });

    const menu = await openMenu();
    expect(menuLabels(menu)).toEqual(["View full prompt"]);
  });

  it("does not expose Edit or Delete for a system style", async () => {
    produceAppState((draft) => {
      draft.toneById["tone-1"].isSystem = true;
    });

    const menu = await openMenu();
    expect(menuLabels(menu)).toEqual(["View full prompt"]);
  });

  it("opens the tone editor when Edit is clicked", async () => {
    const menu = await openMenu();
    const editItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Edit") as HTMLElement | undefined;
    expect(editItem).toBeTruthy();

    await act(async () => {
      editItem?.click();
    });

    const toneActions = await import("../../actions/tone.actions");
    expect(toneActions.openToneEditorDialog).toHaveBeenCalledWith({
      mode: "edit",
      toneId: "tone-1",
    });
  });

  it("deletes the tone when Delete is clicked", async () => {
    const menu = await openMenu();
    const deleteItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Delete") as HTMLElement | undefined;
    expect(deleteItem).toBeTruthy();

    await act(async () => {
      deleteItem?.click();
    });

    const toneActions = await import("../../actions/tone.actions");
    expect(toneActions.deleteTone).toHaveBeenCalledWith("tone-1");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
