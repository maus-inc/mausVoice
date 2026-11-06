// @vitest-environment jsdom
import type { User } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const { deleteToneMock, selectToneMock, deselectToneMock, rejectionMock } =
  vi.hoisted(() => ({
    deleteToneMock: vi.fn(() => Promise.resolve()),
    selectToneMock: vi.fn(() => Promise.resolve()),
    deselectToneMock: vi.fn(() => Promise.resolve()),
    rejectionMock: vi.fn((promise: Promise<unknown>, _context: string) => {
      void promise.catch(() => undefined);
    }),
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

vi.mock("../../actions/tone.actions", () => ({
  deleteTone: deleteToneMock,
  openToneEditorDialog: vi.fn(),
}));
vi.mock("../../actions/user.actions", () => ({
  setSelectedToneId: selectToneMock,
  deselectActiveTone: deselectToneMock,
}));
vi.mock("../../utils/promise.utils", () => ({
  logOnRejection: rejectionMock,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: "/" }),
  };
});

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { LOCAL_USER_ID } from "../../utils/user.utils";
import { ManualStylingRow } from "./ManualStylingRow";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  deleteToneMock.mockResolvedValue(undefined);
  selectToneMock.mockReset().mockResolvedValue(undefined);
  deselectToneMock.mockReset().mockResolvedValue(undefined);
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneById = {
    tone1: {
      id: "tone1",
      name: "My Style",
      promptTemplate: "Write plainly.",
      isSystem: false,
      createdAt: 0,
      sortOrder: 0,
    },
  };
  setAppState(state, true);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const openRowContextMenu = () => {
  const row = container.firstElementChild as HTMLElement;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 100,
  });
  act(() => {
    row.dispatchEvent(event);
  });
  return event;
};

describe("ManualStylingRow selection", () => {
  it("observes a rejected selection", async () => {
    selectToneMock.mockRejectedValueOnce(new Error("save failed"));
    act(() => root.render(createElement(ManualStylingRow, { id: "tone1" })));
    await act(async () => {
      container
        .querySelector("input[type=radio]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(selectToneMock).toHaveBeenCalledWith("tone1");
    expect(rejectionMock).toHaveBeenCalledOnce();
  });

  it("observes a rejected deselection", async () => {
    const state = structuredClone(getAppState());
    state.toneById.other = { ...state.toneById.tone1, id: "other" };
    state.userById[LOCAL_USER_ID] = {
      id: LOCAL_USER_ID,
      activeToneIds: ["tone1", "other"],
    } as User;
    setAppState(state, true);
    deselectToneMock.mockRejectedValueOnce(new Error("save failed"));
    act(() => root.render(createElement(ManualStylingRow, { id: "tone1" })));
    openRowContextMenu();
    const deselect = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Deselect style"));
    expect(deselect).toBeDefined();
    await act(async () => deselect?.click());
    expect(deselectToneMock).toHaveBeenCalledWith("tone1");
    expect(rejectionMock).toHaveBeenCalledOnce();
  });
});

describe("ManualStylingRow destructive delete", () => {
  it("asks for confirmation instead of deleting directly", async () => {
    act(() => {
      root.render(createElement(ManualStylingRow, { id: "tone1" }));
    });
    openRowContextMenu();

    const deleteItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("Delete")) as HTMLElement;
    expect(deleteItem).toBeTruthy();

    act(() => {
      deleteItem.click();
    });

    // No deletion happened yet: the confirmation dialog is up.
    expect(deleteToneMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Are you sure you want to delete this style?",
    );

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Delete",
    ) as HTMLElement;
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton.click();
    });
    expect(deleteToneMock).toHaveBeenCalledTimes(1);
    expect(deleteToneMock).toHaveBeenCalledWith("tone1");
  });

  it("does not delete when the confirmation is cancelled", async () => {
    act(() => {
      root.render(createElement(ManualStylingRow, { id: "tone1" }));
    });
    openRowContextMenu();
    const deleteItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("Delete")) as HTMLElement;
    act(() => {
      deleteItem.click();
    });

    const cancelButton = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Cancel",
    ) as HTMLElement;
    await act(async () => {
      cancelButton.click();
    });

    expect(deleteToneMock).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and swallows the rejection when delete fails", async () => {
    deleteToneMock.mockRejectedValueOnce(new Error("db unavailable"));
    act(() => {
      root.render(createElement(ManualStylingRow, { id: "tone1" }));
    });
    openRowContextMenu();
    const deleteItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("Delete")) as HTMLElement;
    act(() => {
      deleteItem.click();
    });
    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Delete",
    ) as HTMLElement;

    await act(async () => {
      confirmButton.click();
    });

    expect(deleteToneMock).toHaveBeenCalledTimes(1);
    // Dialog stays open so the failure is not mistaken for success.
    expect(document.body.textContent).toContain(
      "Are you sure you want to delete this style?",
    );
  });
});

describe("ManualStylingRow context menu policy", () => {
  it.each(["isGlobal", "isSystem"] as const)(
    "does not offer editing or deletion for %s styles",
    (managedField) => {
      const state = structuredClone(getAppState());
      state.toneById.tone1[managedField] = true;
      setAppState(state, true);
      act(() => root.render(createElement(ManualStylingRow, { id: "tone1" })));
      openRowContextMenu();
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent?.trim(),
      );
      expect(labels).toEqual(["View full prompt"]);
    },
  );

  it("offers deselection only when multiple active styles are available", () => {
    const state = structuredClone(getAppState());
    state.toneById.other = { ...state.toneById.tone1, id: "other" };
    state.userById[LOCAL_USER_ID] = {
      id: LOCAL_USER_ID,
      activeToneIds: ["tone1", "other"],
    } as User;
    setAppState(state, true);
    act(() => root.render(createElement(ManualStylingRow, { id: "tone1" })));
    openRowContextMenu();
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Edit",
      "View full prompt",
      "Deselect style",
      "Delete",
    ]);
  });
});

describe("ManualStylingRow preview", () => {
  it("uses a description when present and otherwise formats the prompt", () => {
    const state = structuredClone(getAppState());
    state.toneById.tone1.promptTemplate =
      "--- Write plainly\nthen summarize — now";
    setAppState(state, true);
    act(() => root.render(createElement(ManualStylingRow, { id: "tone1" })));
    expect(container.textContent).toContain(
      "Write plainly. then summarize now",
    );
    const updated = structuredClone(getAppState());
    updated.toneById.tone1.description = "Short description";
    act(() => setAppState(updated, true));
    expect(container.textContent).toContain("Short description");
    expect(container.textContent).not.toContain(
      "Write plainly. then summarize now",
    );
  });
});
