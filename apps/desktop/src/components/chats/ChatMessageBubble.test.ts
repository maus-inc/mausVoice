// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const h = vi.hoisted(() => ({
  state: {
    chatMessageById: {
      "msg-1": {
        id: "msg-1",
        role: "user",
        content: "Hello there",
        metadata: null,
      },
    },
    streamingMessageById: {},
  },
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(h.state),
}));

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never),
}));

vi.mock("./AgentActivity", () => ({
  AgentActivity: () => null,
}));

vi.mock("../common/OverflowTypography", () => ({
  OverflowTypography: ({ children }: { children?: unknown }) =>
    createElement("span", null, children as never),
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

import { ChatMessageBubble } from "./ChatMessageBubble";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatMessageBubble context menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  const openMenu = async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(ChatMessageBubble, { id: "msg-1" }),
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

  it("opens a context menu with Copy message for a non-empty message", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    const labels = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).map((el) => el.textContent ?? "");
    expect(labels).toEqual(["Copy message"]);
  });

  it("copies the message content when Copy message is clicked", async () => {
    const menu = await openMenu();
    const copyItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Copy message") as
      HTMLElement | undefined;
    expect(copyItem).toBeTruthy();

    await act(async () => {
      copyItem?.click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello there");
    const appActions = await import("../../actions/app.actions");
    expect(appActions.showSnackbar).toHaveBeenCalled();
  });

  it("shows no context menu for an empty message", async () => {
    h.state.chatMessageById["msg-1"] = {
      id: "msg-1",
      role: "user",
      content: "   ",
      metadata: null,
    };
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(ChatMessageBubble, { id: "msg-1" }),
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
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
