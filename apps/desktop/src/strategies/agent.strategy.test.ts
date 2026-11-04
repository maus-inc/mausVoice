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
}));
vi.mock("../repos", () => ({
  getConversationRepo: () => ({
    createConversation: mocks.create,
    deleteConversation: mocks.remove,
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

beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.create
    .mockReset()
    .mockImplementation(async (value: Conversation) => value);
  mocks.remove.mockReset().mockResolvedValue(undefined);
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
  await strategy.cleanup();
  finish(created);
  await expect(starting).rejects.toThrow("delete failed");
  expect(getAppState().chat.conversationIds).not.toContain(created.id);
});
