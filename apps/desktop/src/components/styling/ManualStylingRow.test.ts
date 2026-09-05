// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteToneMock } = vi.hoisted(() => ({
  deleteToneMock: vi.fn(async () => undefined),
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

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: "/" }),
  };
});

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ManualStylingRow } from "./ManualStylingRow";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; MUI menus/tooltips require one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  deleteToneMock.mockResolvedValue(undefined);
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
