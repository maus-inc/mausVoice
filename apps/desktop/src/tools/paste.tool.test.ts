import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTranscriptBeforeInsertMock = vi.hoisted(() => vi.fn());
const createPendingPasteReviewMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const surfaceMainWindowMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const emitToMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userPrefs: { reviewBeforeInsert: true },
  pillConversationId: "conversation-1" as string | null,
}));

vi.mock("../actions/pill-review.actions", () => ({
  reviewTranscriptBeforeInsert: reviewTranscriptBeforeInsertMock,
}));
vi.mock("../actions/pending-paste-review.actions", () => ({
  createPendingPasteReview: createPendingPasteReviewMock,
}));
vi.mock("../store", () => ({ getAppState: () => state }));
vi.mock("../router", () => ({ browserRouter: { navigate: navigateMock } }));
vi.mock("../utils/window.utils", () => ({
  surfaceMainWindow: surfaceMainWindowMock,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: emitToMock }));
vi.mock("../utils/tool-permission.utils", () => ({
  getToolAlwaysAllow: vi.fn(),
  setToolAlwaysAllow: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn(), error: vi.fn() }),
}));

import { PasteTool } from "./paste.tool";

const toolInfo: ToolInfo = {
  id: "paste",
  description: "Paste text",
  instructions: "Paste text",
  schema: { type: "object" },
};

describe("PasteTool review Open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userPrefs = { reviewBeforeInsert: true };
    state.pillConversationId = "conversation-1";
    createPendingPasteReviewMock.mockResolvedValue(undefined);
    navigateMock.mockReset();
    surfaceMainWindowMock.mockResolvedValue(undefined);
  });

  it("uses the invoking Chats conversation when Open has no pill conversation", async () => {
    // An agent can invoke Paste from Chats, where there is no active pill
    // conversation to infer. The explicit call context must keep the review
    // attached to the chat that invoked it.
    state.pillConversationId = null;
    reviewTranscriptBeforeInsertMock.mockImplementation(
      async (
        _text: string,
        onOpen: (editedText: string) => Promise<boolean>,
      ) => {
        expect(await onOpen("edited in the pill")).toBe(true);
        // The review callback only makes the edit durable. Navigation before
        // it settles could race the card's state transition.
        expect(navigateMock).not.toHaveBeenCalled();
        expect(surfaceMainWindowMock).not.toHaveBeenCalled();
        expect(emitToMock).not.toHaveBeenCalled();
        return { action: "open", text: "edited in the pill" };
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conversation-from-chats" },
      ),
    ).resolves.toEqual({
      pendingReview: true,
      delivery: "manual-paste",
    });

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conversation-from-chats",
      "edited in the pill",
    );
    expect(navigateMock).toHaveBeenCalledWith(
      "/dashboard/chats?id=conversation-from-chats",
    );
    expect(surfaceMainWindowMock).toHaveBeenCalledOnce();
    expect(emitToMock).toHaveBeenCalledWith("main", "assistant-mode-close", {});
    expect(invokeMock).not.toHaveBeenCalled();
    expect(
      createPendingPasteReviewMock.mock.invocationCallOrder[0],
    ).toBeLessThan(navigateMock.mock.invocationCallOrder[0]);
    expect(navigateMock.mock.invocationCallOrder[0]).toBeLessThan(
      surfaceMainWindowMock.mock.invocationCallOrder[0],
    );
    expect(surfaceMainWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
      emitToMock.mock.invocationCallOrder[0],
    );
  });

  it("keeps the native review open when storing the edit fails", async () => {
    createPendingPasteReviewMock.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    reviewTranscriptBeforeInsertMock.mockImplementation(
      async (
        _text: string,
        onOpen: (editedText: string) => Promise<boolean>,
      ) => {
        expect(await onOpen("edited in the pill")).toBe(false);
        return { action: "cancel", text: null };
      },
    );

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({
      canceled: true,
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(surfaceMainWindowMock).not.toHaveBeenCalled();
    expect(emitToMock).not.toHaveBeenCalled();
  });
});
