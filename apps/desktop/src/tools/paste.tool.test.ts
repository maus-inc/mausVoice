import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTranscriptBeforeInsertMock = vi.hoisted(() => vi.fn());
const createPendingPasteReviewMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
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
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: loggerErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  }),
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
    // What the Rust `paste` command returns when the text reached the target.
    invokeMock.mockResolvedValue("pasted");
  });

  it("saves the review when the focused target could not take the text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockResolvedValue("copied_to_clipboard");

    await new PasteTool(toolInfo).execute(
      { text: "agent version" },
      { conversationId: "conv-1" },
    );

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited text",
    );
    // The insert is attempted first: the saved review exists for the pastes
    // that did not land, so it cannot be written before the outcome is known.
    expect(invokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      createPendingPasteReviewMock.mock.invocationCallOrder[0],
    );
  });

  it("saves no review when the text already landed in the target", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");

    await new PasteTool(toolInfo).execute(
      { text: "agent version" },
      { conversationId: "conv-1" },
    );

    // The card says a paste is waiting on the user, which is false once the
    // text is in the target app.
    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
  });

  it("saves the review and reports the failure when the insert errors", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockRejectedValue(new Error("Paste is already in progress"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Paste is already in progress");

    // Nothing reached the target, so the text is only recoverable by hand.
    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited text",
    );
  });

  it("keeps the paste successful when the review cannot be saved", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockResolvedValue("copied_to_clipboard");
    createPendingPasteReviewMock.mockRejectedValue(new Error("disk full"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({});

    // The clipboard fallback already delivered the text; a failed bookkeeping
    // write must not be reported as a failed paste.
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "edited text",
      keybind: null,
    });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("reports the insert failure when the review cannot be saved either", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockRejectedValue(new Error("Paste is already in progress"));
    createPendingPasteReviewMock.mockRejectedValue(new Error("disk full"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Paste is already in progress");
  });

  it("saves the review with an empty conversation id when the call carries no context", async () => {
    state.userPrefs = { reviewBeforeInsert: false };
    invokeMock.mockResolvedValue("copied_to_clipboard");

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
