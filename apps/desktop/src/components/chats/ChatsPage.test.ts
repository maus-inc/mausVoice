// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";

const conversationStorage = new Map<string, Conversation>();

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
    listChatMessages: () => Promise.resolve([]),
  }),
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

import ChatsPage from "./ChatsPage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 24 * 60 * 60 * 1000;
const baseTime = Date.now();

const mountPage = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Mounting is synchronous. The async load chain settles inside waitFor,
  // which flushes under act.
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ["/dashboard/chats"] },
          createElement(ChatsPage),
        ),
      ),
    );
  });
  return {
    container,
    waitFor: async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!predicate() && Date.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(predicate(), "timed out waiting for the chats page state").toBe(
        true,
      );
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
  });

  it("renders loaded rows with the selected one showing its time", async () => {
    const seed = (id: string, title: string, updatedDaysAgo: number) => {
      conversationStorage.set(id, {
        id,
        title,
        createdAt: new Date(
          baseTime - DAY_MS * (updatedDaysAgo + 1),
        ).toISOString(),
        updatedAt: new Date(baseTime - DAY_MS * updatedDaysAgo).toISOString(),
      });
    };
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
