// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Conversation } from "@maus-inc/types";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
const media = vi.hoisted(() => ({ compact: true }));
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
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  loadChatMessages: vi.fn(),
}));
vi.mock("./ChatsSideEffects", () => ({ ChatsSideEffects: () => null }));
vi.mock("./ConversationLayout", () => ({
  ConversationLayout: () => <input aria-label="Draft" />,
}));
vi.mock("./ConversationListLayout", () => ({
  ConversationListLayout: ({
    onSelect,
  }: {
    onSelect: (id: string) => void;
  }) => (
    <button aria-current="true" onClick={() => onSelect("one")}>
      First conversation
    </button>
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
