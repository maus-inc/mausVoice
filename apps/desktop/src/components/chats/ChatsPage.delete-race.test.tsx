// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  deleteConversation: vi.fn(),
  createConversation: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("react-intl", async (original) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(original);
});
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showErrorSnackbar,
}));
vi.mock("../../actions/chat.actions", () => ({
  createConversation: mocks.createConversation,
  deleteConversation: mocks.deleteConversation,
  loadChatMessages: vi.fn(),
}));
vi.mock("./ChatsSideEffects", () => ({ ChatsSideEffects: () => null }));
vi.mock("./ConversationLayout", () => ({ ConversationLayout: () => null }));
vi.mock("./ConversationListLayout", () => ({
  ConversationListLayout: ({
    onSelect,
    onDelete,
    onNewChat,
  }: {
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onNewChat: () => void;
  }) => (
    <>
      <button onClick={onNewChat}>New</button>
      <button onClick={() => onDelete("one")}>Delete one</button>
      <button onClick={() => onSelect("three")}>Select three</button>
      <button onClick={() => onSelect("one")}>Select one</button>
    </>
  ),
}));
import ChatsPage from "./ChatsPage";
ensureUiHarness();
const Location = () => <output>{useLocation().search}</output>;

it.each([
  { initial: "one", select: "three", expected: "three" },
  { initial: "three", select: "one", expected: "two" },
])(
  "preserves current selection after a pending delete ($initial to $select)",
  async ({ initial, select, expected }) => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((s) => {
      s.chat.conversationIds = ["one", "two", "three"];
      for (const id of s.chat.conversationIds)
        s.conversationById[id] = { id, title: id } as Conversation;
    });
    let finish!: () => void;
    mocks.deleteConversation.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            produceAppState((s) => {
              s.chat.conversationIds = s.chat.conversationIds.filter(
                (id) => id !== "one",
              );
            });
            resolve();
          };
        }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={[`/dashboard/chats?id=${initial}`]}>
            <ChatsPage />
            <Location />
          </MemoryRouter>,
        ),
      );
      const click = async (label: string) =>
        act(async () =>
          [...host.querySelectorAll("button")]
            .find((b) => b.textContent === label)!
            .click(),
        );
      await click("Delete one");
      await click(`Select ${select}`);
      expect(host.querySelector("output")!.textContent).toBe(`?id=${select}`);
      await act(async () => finish());
      expect(host.querySelector("output")!.textContent).toBe(`?id=${expected}`);
    } finally {
      act(() => root.unmount());
      host.remove();
      mocks.deleteConversation.mockReset();
      setAppState(structuredClone(INITIAL_APP_STATE), true);
    }
  },
);

it.each(["delete", "create"])(
  "does not navigate back after a pending %s completes on another route",
  async (operation) => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((s) => {
      s.chat.conversationIds = ["one"];
      s.conversationById.one = { id: "one", title: "one" } as Conversation;
    });
    let finish!: () => void;
    if (operation === "delete") {
      mocks.deleteConversation.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    } else {
      mocks.createConversation.mockImplementation(
        (conversation: Conversation) =>
          new Promise<Conversation>((resolve) => {
            finish = () => resolve(conversation);
          }),
      );
    }
    const Shell = () => {
      const location = useLocation();
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/other")}>Leave</button>
          {location.pathname === "/dashboard/chats" && <ChatsPage />}
          <output>{location.pathname + location.search}</output>
        </>
      );
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
            <Shell />
          </MemoryRouter>,
        ),
      );
      const click = async (label: string) =>
        act(async () =>
          [...host.querySelectorAll("button")]
            .find((b) => b.textContent === label)!
            .click(),
        );
      await click(operation === "delete" ? "Delete one" : "New");
      await click("Leave");
      await act(async () => finish());
      expect(host.querySelector("output")!.textContent).toBe("/other");
    } finally {
      act(() => root.unmount());
      host.remove();
      mocks.deleteConversation.mockReset();
      mocks.createConversation.mockReset();
      setAppState(structuredClone(INITIAL_APP_STATE), true);
    }
  },
);

it("reports a failed delete without changing the selected thread", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = { id: "one", title: "one" } as Conversation;
  });
  const failure = new Error("delete failed");
  mocks.deleteConversation.mockRejectedValueOnce(failure);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
          <Location />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Delete one")!
        .click(),
    );
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(failure);
    expect(host.querySelector("output")!.textContent).toBe("?id=one");
  } finally {
    act(() => root.unmount());
    host.remove();
    mocks.deleteConversation.mockReset();
    mocks.showErrorSnackbar.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("does not replace a newer selection when a new thread finishes creating", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one", "three"];
    for (const id of s.chat.conversationIds)
      s.conversationById[id] = { id, title: id } as Conversation;
  });
  let finish!: () => void;
  mocks.createConversation.mockImplementation(
    (conversation: Conversation) =>
      new Promise<Conversation>((resolve) => {
        finish = () => resolve(conversation);
      }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
          <Location />
        </MemoryRouter>,
      ),
    );
    const click = async (label: string) =>
      act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === label)!
          .click(),
      );
    await click("New");
    await click("Select three");
    await act(async () => finish());
    expect(host.querySelector("output")!.textContent).toBe("?id=three");
  } finally {
    act(() => root.unmount());
    host.remove();
    mocks.createConversation.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("keeps the most recent new-thread request selected when creations finish out of order", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = { id: "one", title: "one" } as Conversation;
  });
  const pending: Array<{ id: string; finish: () => void }> = [];
  mocks.createConversation.mockImplementation(
    (conversation: Conversation) =>
      new Promise<Conversation>((resolve) => {
        pending.push({
          id: conversation.id,
          finish: () => resolve(conversation),
        });
      }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
          <Location />
        </MemoryRouter>,
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "New",
    )!;
    await act(async () => button.click());
    await act(async () => button.click());
    await act(async () => pending[1].finish());
    expect(host.querySelector("output")!.textContent).toBe(
      `?id=${pending[1].id}`,
    );
    await act(async () => pending[0].finish());
    expect(host.querySelector("output")!.textContent).toBe(
      `?id=${pending[1].id}`,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    mocks.createConversation.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("reports a failed new-thread request without changing the selection", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = { id: "one", title: "one" } as Conversation;
  });
  const failure = new Error("create failed");
  mocks.createConversation.mockRejectedValueOnce(failure);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
          <Location />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "New")!
        .click(),
    );
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(failure);
    expect(host.querySelector("output")!.textContent).toBe("?id=one");
  } finally {
    act(() => root.unmount());
    host.remove();
    mocks.createConversation.mockReset();
    mocks.showErrorSnackbar.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});
