import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTranscriptBeforeInsertMock = vi.hoisted(() => vi.fn());
const createPendingPasteReviewMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userPrefs: { reviewBeforeInsert: true } as { reviewBeforeInsert?: boolean },
}));

vi.mock("../actions/pill-review.actions", () => ({
  reviewTranscriptBeforeInsert: reviewTranscriptBeforeInsertMock,
}));
vi.mock("../actions/pending-paste-review.actions", () => ({
  createPendingPasteReview: createPendingPasteReviewMock,
}));
vi.mock("../store", () => ({ getAppState: () => state }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../utils/tool-permission.utils", () => ({
  getToolAlwaysAllow: vi.fn(),
  setToolAlwaysAllow: vi.fn(),
}));

import { PasteTool } from "./paste.tool";

const toolInfo: ToolInfo = {
  id: "paste",
  description: "Paste text",
  instructions: "Paste text",
  schema: { type: "object" },
};

describe("PasteTool review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userPrefs = { reviewBeforeInsert: true };
    createPendingPasteReviewMock.mockResolvedValue(undefined);
  });

  it("saves the settled text as a pending paste review for the conversation", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");

    await new PasteTool(toolInfo).execute(
      { text: "agent version" },
      { conversationId: "conv-1" },
    );

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited text",
    );
    // The review is the only copy of the text the user can recover once focus
    // has moved to Chats, so it has to exist before the insert that prompts the
    // user to open Chats at all.
    expect(
      createPendingPasteReviewMock.mock.invocationCallOrder[0],
    ).toBeLessThan(invokeMock.mock.invocationCallOrder[0]);
  });

  it("saves the review with an empty conversation id when the call carries no context", async () => {
    state.userPrefs = { reviewBeforeInsert: false };

    await new PasteTool(toolInfo).execute({ text: "agent version" });

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "",
      "agent version",
    );
  });

  it("saves nothing when the review is cancelled", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue(null);

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({ canceled: true });

    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reviews as an assistant-tool source and pastes the settled text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({});

    expect(reviewTranscriptBeforeInsertMock).toHaveBeenCalledWith(
      "agent version",
      "assistant-tool",
    );
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "edited text",
      keybind: null,
    });
  });

  it("cancels the paste when the review returns no text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue(null);

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({ canceled: true });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pastes directly when review-before-insert is disabled", async () => {
    state.userPrefs = { reviewBeforeInsert: false };

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({});

    expect(reviewTranscriptBeforeInsertMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "agent version",
      keybind: null,
    });
  });
});
