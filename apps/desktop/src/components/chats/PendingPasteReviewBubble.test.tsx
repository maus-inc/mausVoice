// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatMessage } from "@maus-inc/types";
import { PENDING_PASTE_REVIEW_TYPE } from "../../actions/pending-paste-review.actions";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

const h = vi.hoisted(() => ({
  state: {
    chatMessageById: {} as Record<string, ChatMessage>,
    streamingMessageById: {} as Record<string, unknown>,
    chatMessageIdsByConversationId: {} as Record<string, string[]>,
    agentStateByConversationId: {} as Record<string, unknown>,
    toolPermissionById: {} as Record<string, unknown>,
  },
}));

vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: vi.fn(), warning: vi.fn() }),
}));

vi.mock("../../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store")>();
  return {
    ...actual,
    useAppStore: (selector: (s: unknown) => unknown) => selector(h.state),
  };
});

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));

vi.mock(
  "../../actions/pending-paste-review.actions",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../actions/pending-paste-review.actions")
      >();
    return {
      ...actual,
      copyPendingPasteReview: vi.fn(async () => undefined),
      cancelPendingPasteReview: vi.fn(async () => undefined),
    };
  },
);

vi.mock("../../actions/chat.actions", () => ({
  editAndResend: vi.fn(async () => undefined),
  laterMessagesHaveToolActivity: vi.fn(() => false),
  retryAssistant: vi.fn(async () => undefined),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ChatMessageBubble } from "./ChatMessageBubble";

const pendingMessage: ChatMessage = {
  id: "pending",
  conversationId: "conv-1",
  role: "system",
  // The action is stored as an empty message: the text lives in metadata, and
  // the row renders the review card instead of content.
  content: "",
  createdAt: "2026-09-23T00:00:00.000Z",
  metadata: {
    type: PENDING_PASTE_REVIEW_TYPE,
    toolName: "paste",
    toolCallState: "awaiting-manual-paste",
    text: "the agent's transcript",
    status: "pending",
  },
};

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  h.state.chatMessageById = { pending: pendingMessage };
  h.state.chatMessageIdsByConversationId = { "conv-1": ["pending"] };
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
});

const render = async () => {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ChatMessageBubble, { id: "pending" }));
  });
};

describe("pending paste review messages", () => {
  it("renders the review card for an empty system message", async () => {
    await render();

    expect(container.textContent).toContain("Paste action waiting for you");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Text prepared for manual paste"] textarea',
      )?.value,
    ).toBe("the agent's transcript");
  });

  it("routes the Copy action to the saved review", async () => {
    await render();

    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy for manual paste",
    );
    if (!copy) throw new Error("Copy button must be rendered");
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });

    const actions = await import("../../actions/pending-paste-review.actions");
    expect(actions.copyPendingPasteReview).toHaveBeenCalledWith(
      pendingMessage,
      "the agent's transcript",
    );
  });

  it("leaves an ordinary empty system message hidden", async () => {
    h.state.chatMessageById = {
      pending: { ...pendingMessage, metadata: null },
    };

    await render();

    // Only the review's own routing lifts an empty row into view; without it the
    // generic guards still hide empty non-assistant messages.
    expect(container.textContent).not.toContain("Paste action waiting for you");
  });
});
