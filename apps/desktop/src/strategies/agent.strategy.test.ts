import type { Conversation } from "@maus-inc/types";
import { beforeEach, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../repos", () => ({
  getConversationRepo: () => ({
    createConversation: mocks.create,
    deleteConversation: mocks.remove,
    listConversations: mocks.list,
  }),
}));
vi.mock("../agents", () => ({
  runAgent: vi.fn(),
  abortAgentLoop: vi.fn(),
  CHAT_AGENT_CONFIG: {},
}));
vi.mock("../i18n", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
import { AgentStrategy } from "./agent.strategy";
import { loadConversations } from "../actions/chat.actions";

beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.create
    .mockReset()
    .mockImplementation(async (value: Conversation) => value);
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset().mockResolvedValue([]);
});

it("registers an active agent conversation and selects it on the pill", async () => {
  const strategy = new AgentStrategy();
  await strategy.onBeforeStart();
  const id = getAppState().pillConversationId;
  expect(id).toBeTruthy();
  expect(getAppState().chat.conversationIds).toContain(id);
  expect(getAppState().conversationById[id!]).toBeDefined();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("removes a conversation cancelled during creation before a clear can proceed", async () => {
  let finish!: () => void;
  let created!: Conversation;
  mocks.create.mockImplementationOnce((value: Conversation) => {
    created = value;
    return new Promise<Conversation>((resolve) => {
      finish = () => resolve(value);
    });
  });
  let finishRemoval!: () => void;
  mocks.remove.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRemoval = resolve;
      }),
  );
  const strategy = new AgentStrategy();
  const starting = strategy.onBeforeStart();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  const loading = loadConversations();
  await Promise.resolve();
  expect(mocks.list).not.toHaveBeenCalled();
  await strategy.cleanup();
  let clearReady = false;
  const clearing = beginLocalDataClear().then((release) => {
    clearReady = true;
    return release;
  });
  finish();
  await vi.waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledWith(created.id, expect.anything()),
  );
  expect(clearReady).toBe(false);
  expect(getAppState().pillConversationId).toBeNull();
  expect(getAppState().chat.conversationIds).not.toContain(created.id);
  expect(getAppState().conversationById[created.id]).toBeUndefined();
  finishRemoval();
  await starting;
  await loading;
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(getAppState().chat.conversationIds).not.toContain(created.id);
  const release = await clearing;
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
});

it("propagates failure to remove a cancelled conversation", async () => {
  let finish!: (value: Conversation) => void;
  let created!: Conversation;
  mocks.create.mockImplementationOnce((value: Conversation) => {
    created = value;
    return new Promise<Conversation>((resolve) => {
      finish = resolve;
    });
  });
  mocks.remove.mockRejectedValueOnce(new Error("delete failed"));
  const strategy = new AgentStrategy();
  const starting = strategy.onBeforeStart();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  await strategy.cleanup();
  finish(created);
  await expect(starting).rejects.toThrow("delete failed");
  expect(getAppState().chat.conversationIds).not.toContain(created.id);
});

it("retries an older list when a conversation was created during the read", async () => {
  let finishList!: (rows: Conversation[]) => void;
  mocks.list.mockImplementationOnce(
    () =>
      new Promise<Conversation[]>((resolve) => {
        finishList = resolve;
      }),
  );
  const loading = loadConversations();
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
  const strategy = new AgentStrategy();
  await strategy.onBeforeStart();
  const id = getAppState().pillConversationId!;
  const saved = getAppState().conversationById[id]!;
  mocks.list.mockResolvedValueOnce([saved]);
  finishList([]);
  await loading;
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(getAppState().chat.conversationIds).toEqual([id]);
});
