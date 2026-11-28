// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";

const conversationStorage = new Map<string, Conversation>();
const messagesByConversation = new Map<string, unknown[]>();
// Referenced lazily inside the factory (see the repo mock below) so the hoisted
// module never reads it before initialisation.
const listChatMessages = vi.fn(async (conversationId: string) => [
  ...(messagesByConversation.get(conversationId) ?? []),
]);
const createConversation = vi.fn(async (conversation: Conversation) => {
  conversationStorage.set(conversation.id, conversation);
  return conversation;
});

// The page tree stays real. Only the persistence boundary is faked, matching
// the convention the action tests use. listConversations sorts by recency
// because the SQL layer guarantees that order.
vi.mock("../../repos", () => ({
  getConversationRepo: () => ({
    listConversations: () =>
      Promise.resolve(
        [...conversationStorage.values()].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      ),
    createConversation: (conversation: Conversation) =>
      createConversation(conversation),
  }),
  getChatMessageRepo: () => ({
    listChatMessages: (conversationId: string) =>
      listChatMessages(conversationId),
  }),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import ChatsPage from "./ChatsPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 24 * 60 * 60 * 1000;
const baseTime = Date.now();

const seed = (id: string, title: string, updatedDaysAgo: number) => {
  conversationStorage.set(id, {
    id,
    title,
    createdAt: new Date(baseTime - DAY_MS * (updatedDaysAgo + 1)).toISOString(),
    updatedAt: new Date(baseTime - DAY_MS * updatedDaysAgo).toISOString(),
  });
};

const mountPage = ({ strict = true }: { strict?: boolean } = {}) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tree = createElement(ChatsPage);
  // Mounting is synchronous. The async load chain settles inside waitFor,
  // which flushes under act.
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard/chats"] },
        strict ? createElement(StrictMode, null, tree) : tree,
      ),
    );
  });
  return {
    container,
    waitFor: async (predicate: () => boolean) => {
      if (predicate()) return;
      await act(async () => {
        await new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (!predicate()) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });
      });
      expect(predicate()).toBe(true);
    },
    settle: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
    click: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const rowStates = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".MuiListItemButton-root")).map(
    (row) => {
      const primary = row.querySelector(".MuiListItemText-primary");
      const spans = Array.from(
        row.querySelectorAll(".MuiListItemText-secondary span span"),
      );
      const isHidden = (element: Element | undefined) =>
        element?.getAttribute("aria-hidden") === "true";
      return {
        title: primary?.textContent ?? "",
        selected: row.classList.contains("Mui-selected"),
        dateHidden: isHidden(spans[0]),
        timeHidden: isHidden(spans[1]),
      };
    },
  );

// The unit files cover the retitling and the crossfade branches in
// isolation. This test proves the real page tree wires them together, so
// the rows users actually see carry the right title and caption state.
describe("ChatsPage sidebar rows", () => {
  let page: ReturnType<typeof mountPage> | null = null;

  afterEach(() => {
    page?.cleanup();
    page = null;
    conversationStorage.clear();
    listChatMessages.mockClear();
  });

  it("renders loaded rows with the selected one showing its time", async () => {
    seed("recent", "Quarterly report numbers", 0);
    seed("legacy", "New conversation", 5);

    const mounted = mountPage();
    page = mounted;
    const { container } = mounted;
    await mounted.waitFor(
      () => container.querySelectorAll(".MuiListItemButton-root").length === 2,
    );

    // The first row auto-selects, so it shows the time. The other row rests
    // on its date. Row order follows the recency sort from the repo.
    expect(rowStates(container)).toEqual([
      {
        title: "Quarterly report numbers",
        selected: true,
        dateHidden: true,
        timeHidden: false,
      },
      {
        title: "New conversation",
        selected: false,
        dateHidden: false,
        timeHidden: true,
      },
    ]);
  });
});

// A cold open used to pay for the same SQL read twice: the first effect both
// wrote the id param and loaded, and the param write re-rendered into the
// second effect, which loaded again. These two tests pin the contract that the
// first effect syncs the URL only and the second effect owns every load.
//
// Neither test wraps the tree in StrictMode. React double-invokes mount effects
// in development builds, which would make an exact call count meaningless. That
// is a dev-only artifact of the harness, not behaviour a user can reach.
describe("ChatsPage message loading", () => {
  let page: ReturnType<typeof mountPage> | null = null;

  afterEach(() => {
    page?.cleanup();
    page = null;
    conversationStorage.clear();
    listChatMessages.mockClear();
  });

  it("reads the auto-selected conversation exactly once on a cold open", async () => {
    seed("recent", "Quarterly report numbers", 0);
    seed("legacy", "New conversation", 5);

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        2,
    );
    await mounted.settle();

    expect(listChatMessages).toHaveBeenCalledTimes(1);
    expect(listChatMessages).toHaveBeenCalledWith("recent");
  });

  it("loads again when the user switches conversation", async () => {
    seed("recent", "Quarterly report numbers", 0);
    seed("legacy", "New conversation", 5);

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        2,
    );
    await mounted.settle();
    listChatMessages.mockClear();

    const rows = mounted.container.querySelectorAll(".MuiListItemButton-root");
    const second = rows[1];
    expect(second).toBeDefined();
    await mounted.click(second);
    await mounted.settle();

    expect(listChatMessages).toHaveBeenCalledTimes(1);
    expect(listChatMessages).toHaveBeenCalledWith("legacy");
  });
});

describe("ChatsPage New Thread deduplication and reuse", () => {
  let page: ReturnType<typeof mountPage> | null = null;

  afterEach(() => {
    page?.cleanup();
    page = null;
    conversationStorage.clear();
    messagesByConversation.clear();
    listChatMessages
      .mockReset()
      .mockImplementation(async (id: string) => [
        ...(messagesByConversation.get(id) ?? []),
      ]);
    createConversation
      .mockReset()
      .mockImplementation(async (conv: Conversation) => {
        conversationStorage.set(conv.id, conv);
        return conv;
      });
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  const seedPopulated = (id: string, title: string, updatedDaysAgo: number) => {
    seed(id, title, updatedDaysAgo);
    messagesByConversation.set(id, [
      {
        id: `msg-${id}`,
        conversationId: id,
        role: "user",
        content: "Hello",
        createdAt: new Date(baseTime - DAY_MS * updatedDaysAgo).toISOString(),
        metadata: null,
      },
    ]);
  };

  it("creates one new thread from a populated conversation and retains it on repeated New Thread clicks", async () => {
    seedPopulated("recent", "Quarterly report numbers", 0);

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        1,
    );
    await mounted.settle();

    const newThreadButton = mounted.container.querySelector<HTMLButtonElement>(
      "[data-conversation-new]",
    );
    if (!newThreadButton) {
      throw new Error("Expected New Thread button");
    }
    await mounted.click(newThreadButton);
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        2,
    );
    await mounted.settle();
    expect(createConversation).toHaveBeenCalledTimes(1);

    const createdId = getAppState().chat.conversationIds[0];
    // Repeated activations while viewing the empty thread must not create another.
    await mounted.click(newThreadButton);
    await mounted.click(newThreadButton);
    await mounted.settle();

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(
      mounted.container.querySelectorAll(".MuiListItemButton-root"),
    ).toHaveLength(2);
    expect(getAppState().chat.conversationIds[0]).toBe(createdId);

    // Once that thread receives a message, New Thread creates a fresh thread again.
    await act(async () => {
      produceAppState((draft) => {
        draft.chatMessageById["msg-new"] = {
          id: "msg-new",
          conversationId: createdId,
          role: "user",
          content: "Follow-up",
          createdAt: new Date().toISOString(),
          metadata: null,
        };
        draft.chatMessageIdsByConversationId[createdId] = ["msg-new"];
      });
    });
    await mounted.click(newThreadButton);
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        3,
    );
    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it("retains an empty existing thread when New Thread is clicked while its messages are loading", async () => {
    seed("empty-existing", "New conversation", 0);
    let resolveMessages: ((messages: unknown[]) => void) | null = null;
    listChatMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve;
        }),
    );

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        1,
    );

    const newThreadButton = mounted.container.querySelector<HTMLButtonElement>(
      "[data-conversation-new]",
    );
    if (!newThreadButton) {
      throw new Error("Expected New Thread button");
    }
    await act(async () => {
      newThreadButton.click();
    });
    expect(createConversation).not.toHaveBeenCalled();

    await act(async () => {
      if (!resolveMessages) {
        throw new Error("Expected pending listChatMessages resolver");
      }
      resolveMessages([]);
    });
    await mounted.settle();

    expect(createConversation).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelectorAll(".MuiListItemButton-root"),
    ).toHaveLength(1);
    expect(getAppState().chat.conversationIds).toEqual(["empty-existing"]);
  });

  it("creates at most one thread when activating the empty-state chip repeatedly", async () => {
    let resolveCreate: (() => void) | null = null;
    createConversation.mockImplementationOnce(
      (conversation: Conversation) =>
        new Promise<Conversation>((resolve) => {
          conversationStorage.set(conversation.id, conversation);
          resolveCreate = () => resolve(conversation);
        }),
    );

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () => mounted.container.textContent?.includes("Create new chat") ?? false,
    );

    const chip = [
      ...mounted.container.querySelectorAll('[role="button"]'),
    ].find((el) => el.textContent === "Create new chat");
    const newThreadButton = mounted.container.querySelector<HTMLButtonElement>(
      "[data-conversation-new]",
    );
    if (!chip || !newThreadButton) {
      throw new Error("Expected empty-state chip and New Thread button");
    }
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      newThreadButton.click();
    });
    expect(createConversation).toHaveBeenCalledTimes(1);

    await act(async () => {
      if (!resolveCreate) {
        throw new Error("Expected pending createConversation resolver");
      }
      resolveCreate();
    });
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        1,
    );
    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it("creates at most one thread under rapid repeated clicks while creation is pending", async () => {
    seedPopulated("recent", "Quarterly report numbers", 0);
    let resolveCreate: (() => void) | null = null;
    createConversation.mockImplementationOnce(
      (conversation: Conversation) =>
        new Promise<Conversation>((resolve) => {
          conversationStorage.set(conversation.id, conversation);
          resolveCreate = () => resolve(conversation);
        }),
    );

    const mounted = mountPage({ strict: false });
    page = mounted;
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        1,
    );
    await mounted.settle();

    const newThreadButton = mounted.container.querySelector<HTMLButtonElement>(
      "[data-conversation-new]",
    );
    if (!newThreadButton) {
      throw new Error("Expected New Thread button");
    }
    await act(async () => {
      newThreadButton.click();
      newThreadButton.click();
      newThreadButton.click();
    });
    expect(createConversation).toHaveBeenCalledTimes(1);

    await act(async () => {
      if (!resolveCreate) {
        throw new Error("Expected pending createConversation resolver");
      }
      resolveCreate();
    });
    await mounted.waitFor(
      () =>
        mounted.container.querySelectorAll(".MuiListItemButton-root").length ===
        2,
    );
    expect(createConversation).toHaveBeenCalledTimes(1);
  });
});
