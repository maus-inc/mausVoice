// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatMessage } from "@maus-inc/types";
import { PENDING_PASTE_REVIEW_TYPE } from "../../actions/pending-paste-review.actions";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

const mocks = vi.hoisted(() => ({
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
    useAppStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
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
      copyPendingPasteReview: vi.fn(() => Promise.resolve()),
      cancelPendingPasteReview: vi.fn(() => Promise.resolve()),
    };
  },
);

vi.mock("../../actions/chat.actions", () => ({
  editAndResend: vi.fn(() => Promise.resolve()),
  laterMessagesHaveToolActivity: vi.fn(() => false),
  retryAssistant: vi.fn(() => Promise.resolve()),
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
  mocks.state.chatMessageById = { pending: pendingMessage };
  mocks.state.chatMessageIdsByConversationId = { "conv-1": ["pending"] };
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

/** Re-renders the same bubble, as any parent re-render would. */
const rerender = async () => {
  await act(async () => {
    root?.render(createElement(ChatMessageBubble, { id: "pending" }));
  });
};

const resolveReview = (status: "copied" | "canceled") => {
  mocks.state.chatMessageById = {
    pending: {
      ...pendingMessage,
      metadata: { ...pendingMessage.metadata, status },
    },
  };
};

describe("pending paste review messages", () => {
  it("renders the review card for an empty system message", async () => {
    await render();

    expect(container.textContent).toContain("Paste action waiting for you");
    // The field is a MUI `TextField` with `multiline`, which renders a
    // `.MuiFormControl-root` div carrying the `aria-label` and a `<textarea>`
    // inside it. The label is on the wrapper, not on the textarea, so a selector
    // asking for the textarea *itself* to be labelled -- or for a textarea
    // outside the labelled subtree -- matches nothing and asserts `undefined`
    // against a string, which fails loudly but for the wrong reason.
    const labelled = container.querySelector(
      '[aria-label="Text prepared for manual paste"]',
    );
    expect(labelled, "the manual-paste field must be labelled").toBeTruthy();
    const field = labelled?.querySelector("textarea");
    expect(
      field,
      "the labelled element must contain the multiline field",
    ).toBeTruthy();
    expect(field?.value).toBe("the agent's transcript");
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
    mocks.state.chatMessageById = {
      pending: { ...pendingMessage, metadata: null },
    };

    await render();

    // Only the review's own routing lifts an empty row into view; without it the
    // generic guards still hide empty non-assistant messages.
    expect(container.textContent).not.toContain("Paste action waiting for you");
  });

  it("focuses the outcome when the pending instructions are replaced", async () => {
    await render();
    resolveReview("copied");
    await rerender();

    // The Copy and Cancel buttons unmount with the instructions, so focus has to
    // land on the outcome rather than on a removed node.
    const outcome = container.querySelector<HTMLElement>(
      '[role="status"][tabindex="0"]',
    );
    expect(outcome?.textContent).toBe("Copied for manual paste");
    expect(document.activeElement).toBe(outcome);
  });

  it("does not pull focus back on a later re-render", async () => {
    await render();
    resolveReview("copied");
    await rerender();

    // The user moves on to something else entirely while the card stays on
    // screen. Every keystroke elsewhere re-renders this bubble, and a ref
    // callback that is a new function each render would drag focus back into
    // the resolved card on all of them.
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await rerender();

    expect(document.activeElement).toBe(elsewhere);
  });

  it("does not focus anything while the review is still pending", async () => {
    await render();
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    elsewhere.focus();

    await rerender();

    expect(document.activeElement).toBe(elsewhere);
  });
});
