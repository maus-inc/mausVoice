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
        conversationId: "conv-1",
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

const chatActionsMock = vi.hoisted(() => ({
  editAndResend: vi.fn((..._args: unknown[]) => Promise.resolve()),
  laterMessagesHaveToolActivity: vi.fn((..._args: unknown[]) => false),
}));

vi.mock("../../actions/chat.actions", () => ({
  editAndResend: (...args: unknown[]) => chatActionsMock.editAndResend(...args),
  laterMessagesHaveToolActivity: (...args: unknown[]) =>
    chatActionsMock.laterMessagesHaveToolActivity(...args),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never),
}));

vi.mock("../common/OverflowTypography", () => ({
  OverflowTypography: ({ children }: { children?: unknown }) =>
    createElement("span", null, children as never),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
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

  it("opens a context menu with Copy and Edit for a non-empty user message", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    const labels = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).map((el) => el.textContent ?? "");
    expect(labels).toEqual(["Copy message", "Edit and resend"]);
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

  it("offers only Edit and resend for an empty user message", async () => {
    h.state.chatMessageById["msg-1"] = {
      id: "msg-1",
      conversationId: "conv-1",
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
    const labels = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).map((el) => el.textContent ?? "");
    expect(labels).toEqual(["Edit and resend"]);
  });
});

describe("ChatMessageBubble edit and resend", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    h.state.chatMessageById["msg-1"] = {
      id: "msg-1",
      conversationId: "conv-1",
      role: "user",
      content: "Hello there",
      metadata: null,
    };
    chatActionsMock.editAndResend.mockClear();
    chatActionsMock.laterMessagesHaveToolActivity.mockClear();
    chatActionsMock.laterMessagesHaveToolActivity.mockReturnValue(false);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  const renderBubble = async () => {
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
  };

  const openEdit = async () => {
    await renderBubble();
    const row = container.querySelector<HTMLElement>("div");
    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    const editItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent === "Edit and resend") as
      HTMLElement | undefined;
    expect(editItem).toBeTruthy();
    await act(async () => {
      editItem?.click();
      await Promise.resolve();
    });
  };

  const setDraft = async (value: string) => {
    const field = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit message"] textarea',
    );
    expect(field).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(field, value);
      field?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("resends directly when nothing later would be dropped", async () => {
    await openEdit();
    await setDraft("Hello again");

    const resend = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Resend",
    );
    expect(resend).not.toBeNull();
    await act(async () => {
      resend?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chatActionsMock.editAndResend).toHaveBeenCalledWith(
      "conv-1",
      "msg-1",
      "Hello again",
    );
  });

  it("asks confirmation before dropping later tool activity", async () => {
    chatActionsMock.laterMessagesHaveToolActivity.mockReturnValue(true);
    await openEdit();
    await setDraft("Hello again");

    const first = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Resend",
    );
    await act(async () => {
      first?.click();
      await Promise.resolve();
    });
    // First click only arms the confirmation; nothing is sent yet.
    expect(chatActionsMock.editAndResend).not.toHaveBeenCalled();

    const confirm = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Drop later messages and resend",
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(chatActionsMock.editAndResend).toHaveBeenCalledTimes(1);
  });
});
