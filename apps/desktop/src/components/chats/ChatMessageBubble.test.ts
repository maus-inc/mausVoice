// @vitest-environment jsdom
import {
  menuLabels,
  openContextMenu,
} from "../../../test/helpers/context-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StreamingMessageState } from "../../state/app.state";
import type { ChatMessage } from "@maus-inc/types";

const h = vi.hoisted(() => ({
  state: {
    chatMessageById: {
      user: {
        id: "user",
        conversationId: "conv-1",
        role: "user",
        content: "Question",
        metadata: null,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
      "msg-1": {
        id: "msg-1",
        conversationId: "conv-1",
        role: "user",
        content: "Hello there",
        metadata: null,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    } as Record<string, ChatMessage>,
    streamingMessageById: {} as Record<string, StreamingMessageState>,
    chatMessageIdsByConversationId: {} as Record<string, string[]>,
    agentStateByConversationId: {} as Record<
      string,
      { status: string; error?: string; aborted: boolean; toolCalls: unknown[] }
    >,
  },
}));

vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: vi.fn() }),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(h.state),
}));

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));

const chatActionsMock = vi.hoisted(() => ({
  retryAssistant: vi.fn(async (_conversationId: string) => undefined),
  editAndResend: vi.fn((..._args: unknown[]) => Promise.resolve()),
  laterMessagesHaveToolActivity: vi.fn((..._args: unknown[]) => false),
}));

vi.mock("../../actions/chat.actions", () => ({
  retryAssistant: chatActionsMock.retryAssistant,
  editAndResend: (...args: unknown[]) => chatActionsMock.editAndResend(...args),
  laterMessagesHaveToolActivity: (...args: unknown[]) =>
    chatActionsMock.laterMessagesHaveToolActivity(...args),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("../common/OverflowTypography", () => ({
  OverflowTypography: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { showErrorSnackbar } from "../../actions/app.actions";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ReasoningPart } from "./ChatMessageParts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const renderMessage = (root: ReturnType<typeof createRoot>) =>
  act(async () => {
    root.render(createElement(ChatMessageBubble, { id: "msg-1" }));
  });

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
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
        createElement(
          StrictMode,
          null,
          createElement(ChatMessageBubble, { id: "msg-1" }),
        ),
      );
    });
    return openContextMenu(container);
  };

  it("opens a context menu with Copy and Edit for a non-empty user message", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    const labels = menuLabels(menu);
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
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const labels = menuLabels(await openMenu());
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
      createdAt: "2026-09-23T00:00:00.000Z",
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
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
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

  it("keeps the edited draft and reports a failed resend", async () => {
    const error = new Error("Unable to save message");
    chatActionsMock.editAndResend.mockRejectedValueOnce(error);
    await openEdit();
    await setDraft("Keep this draft");
    const resend = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Resend",
    );
    expect(resend).toBeTruthy();
    await act(async () => {
      resend?.click();
    });
    expect(container.querySelector("textarea")?.value).toBe("Keep this draft");
    expect(showErrorSnackbar).toHaveBeenCalledWith(error);
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

describe("empty assistant run notes", () => {
  it.each(["error", "stopped"] as const)(
    "retains the %s note without assistant text",
    async (outcome) => {
      const previous = h.state.chatMessageById["msg-1"];
      h.state.chatMessageById["msg-1"] = {
        ...previous,
        role: "assistant",
        content: "",
      };
      h.state.chatMessageIdsByConversationId["conv-1"] = ["user", "msg-1"];
      h.state.agentStateByConversationId["conv-1"] = {
        status: outcome === "error" ? "error" : "done",
        error: outcome === "error" ? "Provider failed." : undefined,
        aborted: outcome === "stopped",
        toolCalls: [],
      };
      chatActionsMock.retryAssistant.mockClear();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(createElement(ChatMessageBubble, { id: "msg-1" })),
        );
        expect(container.textContent).toContain(
          outcome === "error" ? "Provider failed." : "Stopped.",
        );
        const retry = [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Retry",
        );
        if (outcome === "error") {
          if (!retry) throw new Error("retry button must be rendered");
          await act(async () => retry.click());
          expect(chatActionsMock.retryAssistant).toHaveBeenCalledWith("conv-1");
          const failure = new Error("Retry persistence failed");
          chatActionsMock.retryAssistant.mockRejectedValueOnce(failure);
          await act(async () => retry.click());
          expect(showErrorSnackbar).toHaveBeenCalledWith(failure);
        } else expect(retry).toBeUndefined();
      } finally {
        act(() => root.unmount());
        container.remove();
        h.state.chatMessageById["msg-1"] = previous;
        h.state.chatMessageIdsByConversationId = {};
        h.state.agentStateByConversationId = {};
      }
    },
  );
});

describe("persisted run notes", () => {
  it.each([
    ["error", false],
    ["aborted", false],
    ["error", true],
    ["aborted", true],
  ] as const)(
    "shows %s after reload (tool tail: %s), but not during a new run",
    async (outcome, withTool) => {
      const previous = h.state.chatMessageById["msg-1"];
      h.state.chatMessageById["msg-1"] = {
        ...previous,
        role: "assistant",
        content: "",
        metadata: { runOutcome: outcome },
      };
      h.state.chatMessageById.tool = {
        ...previous,
        id: "tool",
        role: "system",
        content: "result",
        metadata: {
          type: "tool-result",
          toolName: "paste",
          toolCallId: "call",
        },
      };
      h.state.chatMessageIdsByConversationId["conv-1"] = [
        "user",
        "msg-1",
        ...(withTool ? ["tool"] : []),
      ];
      h.state.agentStateByConversationId = {};
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const expected =
        outcome === "error" ? "Something went wrong." : "Stopped.";
      try {
        await renderMessage(root);
        expect(container.textContent).toContain(expected);
        expect(container.textContent).not.toContain("Thinking");
        expect(container.textContent?.includes("Retry")).toBe(
          outcome === "error",
        );
        h.state.agentStateByConversationId["conv-1"] = {
          status: "idle",
          aborted: false,
          toolCalls: [],
        };
        await renderMessage(root);
        expect(container.textContent).not.toContain(expected);
        expect(container.textContent).not.toContain("Retry");
        h.state.agentStateByConversationId = {};
        h.state.chatMessageIdsByConversationId["conv-1"].push("user");
        await renderMessage(root);
        expect(container.textContent).not.toContain(expected);
      } finally {
        act(() => root.unmount());
        container.remove();
        h.state.chatMessageById["msg-1"] = previous;
        delete h.state.chatMessageById.tool;
        h.state.chatMessageIdsByConversationId = {};
        h.state.agentStateByConversationId = {};
      }
    },
  );
});

it("reasoning follows streaming changes without undoing a manual toggle on each chunk", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (open: boolean, text = "Reasoning") =>
    act(async () => {
      root.render(
        createElement(ReasoningPart, {
          part: { kind: "reasoning", text, open },
        }),
      );
    });
  const expanded = () =>
    container.querySelector("button")?.getAttribute("aria-expanded");
  try {
    await render(true);
    expect(expanded()).toBe("true");
    await act(async () => container.querySelector("button")?.click());
    expect(expanded()).toBe("false");
    await render(true, "Another chunk");
    expect(expanded()).toBe("false");
    await render(false);
    await render(true);
    expect(expanded()).toBe("true");
    await render(false);
    expect(expanded()).toBe("false");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

describe("retrying the latest completed assistant reply", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    chatActionsMock.retryAssistant.mockReset().mockResolvedValue(undefined);
    vi.mocked(showErrorSnackbar).mockClear();
    h.state.chatMessageById["msg-1"] = {
      id: "msg-1",
      conversationId: "conv-1",
      role: "assistant",
      content: "Completed reply",
      metadata: null,
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    h.state.chatMessageIdsByConversationId = { "conv-1": ["user", "msg-1"] };
    h.state.agentStateByConversationId = {};
    h.state.streamingMessageById = {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete h.state.chatMessageById.tool;
    h.state.chatMessageIdsByConversationId = {};
    h.state.agentStateByConversationId = {};
    h.state.streamingMessageById = {};
  });
  const retry = () =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
  it.each([
    [false, "Completed reply"],
    [true, "Completed reply"],
    [false, ""],
  ] as const)(
    "offers one-click retry (tool tail=%s, content=%s)",
    async (toolTail, content) => {
      h.state.chatMessageById["msg-1"].content = content;
      if (toolTail) {
        h.state.chatMessageById.tool = {
          ...h.state.chatMessageById["msg-1"],
          id: "tool",
          role: "system",
          metadata: {
            type: "tool-result",
            toolName: "paste",
            toolCallId: "call",
          },
        };
        h.state.chatMessageIdsByConversationId["conv-1"].push("tool");
      }
      await renderMessage(root);
      expect(retry()).toBeDefined();
      expect(container.textContent).not.toContain("Thinking");
      if (toolTail)
        chatActionsMock.retryAssistant.mockRejectedValueOnce(
          new Error("retry failed"),
        );
      const retryButton = retry();
      if (!retryButton) throw new Error("retry button must be rendered");
      await act(async () => retryButton.click());
      expect(chatActionsMock.retryAssistant).toHaveBeenCalledExactlyOnceWith(
        "conv-1",
      );
      if (toolTail)
        expect(showErrorSnackbar).toHaveBeenCalledWith(
          expect.objectContaining({ message: "retry failed" }),
        );
    },
  );
  it.each([
    "streaming",
    "idle",
    "calling-llm",
    "processing-tools",
    "aborted",
    "older",
  ])("does not offer retry for %s replies", async (state) => {
    if (state === "streaming")
      h.state.streamingMessageById = {
        "msg-1": { toolCalls: [], reasoning: "", isStreaming: true },
      };
    else if (state === "aborted")
      h.state.chatMessageById["msg-1"].metadata = { runOutcome: "aborted" };
    else if (state === "older")
      h.state.chatMessageIdsByConversationId["conv-1"].push("user");
    else
      h.state.agentStateByConversationId["conv-1"] = {
        status: state,
        aborted: false,
        toolCalls: [],
      };
    await renderMessage(root);
    expect(retry()).toBeUndefined();
  });
});
