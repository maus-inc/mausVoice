// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";

const conversationStorage = new Map<string, Conversation>();
// Referenced lazily inside the factory (see the repo mock below) so the hoisted
// module never reads it before initialisation.
const listChatMessages = vi.fn(async (_conversationId: string) => []);

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
