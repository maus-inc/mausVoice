// @vitest-environment jsdom
import {
  openContextMenu,
  menuLabels,
} from "../../../test/helpers/context-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Term } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const h = vi.hoisted(() => ({ deleteTerm: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: vi.fn(async () => null),
  };
});

vi.mock("../../repos", () => ({
  getTermRepo: () => ({
    deleteTerm: h.deleteTerm,
  }),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ContextMenuProvider } from "../common/ContextMenu";
import { DictionaryRow } from "./DictionaryRow";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const seedRow = () => {
  produceAppState((draft) => {
    draft.termById["term-1"] = {
      id: "term-1",
      sourceValue: "foo",
      destinationValue: "bar",
      isReplacement: true,
      isGlobal: false,
    } as unknown as Term;
    draft.dictionary.termIds = ["term-1"];
  });
};

describe("DictionaryRow context menu", () => {
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
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
        createElement(
          StrictMode,
          null,
          createElement(DictionaryRow, { id: "term-1" }),
        ),
      );
    });
    return openContextMenu(container);
  };

  it("opens a context menu with only Delete (inline editing has no modal edit entry point)", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    // Dictionary rows are inline-editable, so there is no separate "Edit"
    // context-menu action; only the destructive Delete is surfaced.
    expect(menuLabels(menu)).toEqual(["Delete"]);
  });

  it("does not expose Delete for an organization-managed term", async () => {
    produceAppState((draft) => {
      draft.termById["term-1"].isGlobal = true;
    });

    const menu = await openMenu();
    expect(menu).toBeNull();
  });

  it("routes editable fields to the provider clipboard menu instead of Delete", async () => {
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
        createElement(
          StrictMode,
          null,
          createElement(
            ContextMenuProvider,
            null,
            createElement(DictionaryRow, { id: "term-1" }),
          ),
        ),
      );
    });

    const input = container.querySelector<HTMLInputElement>("input")!;
    input.setSelectionRange(0, 3);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    const labels = menuLabels(document.querySelector('[role="menu"]'));
    expect(event.defaultPrevented).toBe(true);
    expect(labels.some((label) => label.startsWith("Copy"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Paste"))).toBe(true);
    expect(labels).not.toContain("Delete");
  });

  it("deletes the term when the Delete item is clicked", async () => {
    const menu = await openMenu();
    const deleteItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Delete") as HTMLElement | undefined;
    expect(deleteItem).toBeTruthy();

    await act(async () => {
      deleteItem?.click();
    });

    const repo = await import("../../repos");
    expect(repo.getTermRepo().deleteTerm).toHaveBeenCalledWith("term-1");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
