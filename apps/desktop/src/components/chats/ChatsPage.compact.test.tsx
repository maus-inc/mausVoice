// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
const media = vi.hoisted(() => ({ compact: true }));
const chatActionMocks = vi.hoisted(() => ({
  requestNewConversation: vi.fn(),
}));
vi.mock("@mui/material", async (original) => ({
  ...(await original<typeof import("@mui/material")>()),
  useMediaQuery: () => media.compact,
}));
vi.mock("react-intl", async (original) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(original);
});
vi.mock("../../actions/chat.actions", () => ({
  canReuseEmptyConversation: (id: string | null | undefined) => {
    if (!id) return false;
    const ids = getAppState().chatMessageIdsByConversationId[id];
    return Array.isArray(ids) && ids.length === 0;
  },
  deleteConversation: vi.fn(),
  loadChatMessages: vi.fn(async () => undefined),
  requestNewConversation: chatActionMocks.requestNewConversation,
  resolveReusableEmptyConversation: vi.fn(async () => null),
}));
vi.mock("./ChatsSideEffects", () => ({ ChatsSideEffects: () => null }));
vi.mock("./ConversationLayout", () => ({
  ConversationLayout: () => <input aria-label="Draft" />,
}));
vi.mock("./ConversationListLayout", () => ({
  ConversationListLayout: ({
    onSelect,
    onNewChat,
  }: {
    onSelect: (id: string) => void;
    onNewChat: () => void;
  }) => (
    <>
      <button aria-current="true" onClick={() => onSelect("one")}>
        First conversation
      </button>
      <button onClick={onNewChat}>New</button>
    </>
  ),
}));
import ChatsPage from "./ChatsPage";
ensureUiHarness();
it("keeps the draft when switching between the compact list and selected conversation", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = {
      id: "one",
      title: "First conversation",
    } as Conversation;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    const draft = host.querySelector<HTMLInputElement>(
      'input[aria-label="Draft"]',
    )!;
    draft.value = "unfinished";
    const back = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Chats",
    )!;
    await act(async () => back.click());
    const list = host.querySelector<HTMLElement>('[aria-current="true"]')!;
    expect(getComputedStyle(list.parentElement!).display).not.toBe("none");
    expect(getComputedStyle(draft.parentElement!).display).toBe("none");
    await act(async () => list.click());
    expect(getComputedStyle(draft.parentElement!).display).not.toBe("none");
    expect(host.querySelector('input[aria-label="Draft"]')).toBe(draft);
    expect(draft.value).toBe("unfinished");
  } finally {
    act(() => root.unmount());
    host.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("shows a new URL-selected conversation after opening the compact list", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const Navigate = () => {
    const navigate = useNavigate();
    return <button onClick={() => navigate("?id=other")}>Open other</button>;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <Navigate />
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    const button = (text: string) =>
      [...host.querySelectorAll("button")].find(
        (item) => item.textContent === text,
      )!;
    await act(async () => button("Chats").click());
    const draft = host.querySelector<HTMLInputElement>(
      'input[aria-label="Draft"]',
    )!;
    expect(getComputedStyle(draft.parentElement!).display).toBe("none");
    const list = host.querySelector<HTMLElement>('[aria-current="true"]')!;
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
    await act(async () => button("Open other").click());
    await act(
      async () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(button("Chats"));
    const otherDraft = host.querySelector<HTMLInputElement>(
      'input[aria-label="Draft"]',
    )!;
    expect(getComputedStyle(otherDraft.parentElement!).display).not.toBe(
      "none",
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("moves focus off a compact back button when the wide layout removes it", async () => {
  media.compact = true;
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = {
      id: "one",
      title: "First conversation",
    } as Conversation;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const tree = (
    <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
      <ChatsPage />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(tree));
    const back = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Chats",
    )!;
    act(() => back.focus());
    expect(document.activeElement).toBe(back);
    media.compact = false;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    expect(document.activeElement).toBe(
      host.querySelector('[aria-current="true"]'),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    media.compact = true;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("does not steal focus from an external control when resizing", async () => {
  media.compact = true;
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = {
      id: "one",
      title: "First conversation",
    } as Conversation;
  });
  const host = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(host, outside);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    const back = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Chats",
    )!;
    act(() => {
      back.focus();
      outside.focus();
    });
    media.compact = false;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    expect(document.activeElement).toBe(outside);
  } finally {
    act(() => root.unmount());
    host.remove();
    outside.remove();
    media.compact = true;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});

it("closes the compact list when activating New Thread on an already empty conversation", async () => {
  media.compact = true;
  chatActionMocks.requestNewConversation.mockReset();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((s) => {
    s.chat.conversationIds = ["one"];
    s.conversationById.one = {
      id: "one",
      title: "New conversation",
    } as Conversation;
    s.chatMessageIdsByConversationId.one = [];
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/chats?id=one"]}>
          <ChatsPage />
        </MemoryRouter>,
      ),
    );
    const button = (text: string) => {
      const found = [...host.querySelectorAll("button")].find(
        (item) => item.textContent === text,
      );
      if (!found) {
        throw new Error(`Expected button with text "${text}"`);
      }
      return found;
    };
    await act(async () => button("Chats").click());
    const draft = host.querySelector<HTMLInputElement>(
      'input[aria-label="Draft"]',
    );
    const draftWrapper = draft?.parentElement;
    if (!draftWrapper) {
      throw new Error("Expected draft input wrapper");
    }
    expect(getComputedStyle(draftWrapper).display).toBe("none");

    const newButton = button("New");
    const origMatches = newButton.matches.bind(newButton);
    vi.spyOn(newButton, "matches").mockImplementation((selector: string) =>
      selector === ":focus-visible" ? true : origMatches(selector),
    );
    act(() => newButton.focus());
    await act(async () => newButton.click());
    await act(
      async () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );

    expect(chatActionMocks.requestNewConversation).not.toHaveBeenCalled();
    expect(getComputedStyle(draftWrapper).display).not.toBe("none");
    expect(document.activeElement).toBe(button("Chats"));
  } finally {
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
    chatActionMocks.requestNewConversation.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  }
});
