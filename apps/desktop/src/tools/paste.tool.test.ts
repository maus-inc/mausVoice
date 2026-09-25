import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTranscriptBeforeInsertMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userPrefs: { reviewBeforeInsert: true } as { reviewBeforeInsert?: boolean },
}));

vi.mock("../actions/pill-review.actions", () => ({
  reviewTranscriptBeforeInsert: reviewTranscriptBeforeInsertMock,
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
