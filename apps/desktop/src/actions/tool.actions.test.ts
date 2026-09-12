import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAppStateMock, createToolMock, toolExecuteMock } = vi.hoisted(() => ({
  getAppStateMock: vi.fn(),
  createToolMock: vi.fn(),
  toolExecuteMock: vi.fn(),
}));

vi.mock("../store", () => ({
  getAppState: () => getAppStateMock(),
  produceAppState: vi.fn(),
}));

vi.mock("../tools", () => ({ createTool: createToolMock }));

import { executeTool } from "./tool.actions";

const pasteInfo = {
  id: "paste",
  description: "Paste text",
  instructions: "Paste text",
  schema: { type: "object" },
};

describe("executeTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppStateMock.mockReturnValue({ toolInfoById: { paste: pasteInfo } });
    createToolMock.mockReturnValue({ execute: toolExecuteMock });
    toolExecuteMock.mockResolvedValue({});
  });

  it("keeps the invoking conversation attached to an agent tool call", async () => {
    const context = { conversationId: "conversation-from-chats" };

    await executeTool("paste", { text: "edited text" }, context);

    expect(toolExecuteMock).toHaveBeenCalledWith(
      { text: "edited text" },
      context,
    );
  });
});
