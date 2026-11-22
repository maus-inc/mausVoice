import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { LocalChatMessageRepo } from "./chat-message.repo";

const repo = new LocalChatMessageRepo();

const localMessage = (metadata: string | null) => ({
  id: "m1",
  conversationId: "c1",
  role: "assistant",
  content: "hello",
  createdAt: 1_700_000_000_000,
  metadata,
});

describe("LocalChatMessageRepo metadata parsing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("parses a valid JSON object metadata column", async () => {
    invokeMock.mockResolvedValue([localMessage('{"type":"tool-result"}')]);
    const [message] = await repo.listChatMessages("c1");
    expect(message.metadata).toEqual({ type: "tool-result" });
  });

  it("reads a null metadata column as null", async () => {
    invokeMock.mockResolvedValue([localMessage(null)]);
    const [message] = await repo.listChatMessages("c1");
    expect(message.metadata).toBeNull();
  });

  it("does not throw on a corrupt metadata column and reads it as null", async () => {
    invokeMock.mockResolvedValue([localMessage("{not json")]);
    const [message] = await repo.listChatMessages("c1");
    expect(message.metadata).toBeNull();
  });

  it("keeps the other messages when one row is corrupt", async () => {
    invokeMock.mockResolvedValue([
      localMessage("{not json"),
      localMessage('{"ok":true}'),
    ]);
    const messages = await repo.listChatMessages("c1");
    expect(messages).toHaveLength(2);
    expect(messages[0].metadata).toBeNull();
    expect(messages[1].metadata).toEqual({ ok: true });
  });

  it("rejects a non-object JSON root as null", async () => {
    invokeMock.mockResolvedValue([localMessage("[1,2,3]")]);
    const [message] = await repo.listChatMessages("c1");
    expect(message.metadata).toBeNull();
  });
});
