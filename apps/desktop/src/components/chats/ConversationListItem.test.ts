// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Conversation } from "@maus-inc/types";

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
      formatDate: () => "date",
      formatTime: () => "time",
    }),
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

import { ConversationListItem } from "./ConversationListItem";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sampleConversation: Conversation = {
  id: "conv-1",
  title: "My conversation",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
} as unknown as Conversation;

describe("ConversationListItem context menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  const onDelete = vi.fn();
  const onSelect = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    onDelete.mockClear();
  });

  const openMenu = async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(ConversationListItem, {
            conversation: sampleConversation,
            selected: false,
            onSelect,
            onDelete,
          }),
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

  it("opens a context menu with only Delete conversation (no rename entry point exists)", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    const labels = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).map((el) => el.textContent ?? "");
    expect(labels).toEqual(["Delete conversation"]);
  });

  it("calls onDelete when Delete conversation is clicked", async () => {
    const menu = await openMenu();
    const deleteItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Delete conversation") as
      HTMLElement | undefined;
    expect(deleteItem).toBeTruthy();

    await act(async () => {
      deleteItem?.click();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
