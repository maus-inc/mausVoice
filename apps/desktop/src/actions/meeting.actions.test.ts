import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingSegment } from "../types/meetings.types";
import {
  createMeetingConversation,
  generateMeetingSummary,
  stopMeetingRecording,
} from "./meeting.actions";

const {
  loggerMock,
  completeMeetingMock,
  updateMeetingMock,
  generateTextMock,
  createConversationMock,
  createChatMessageMock,
  emitEventMock,
} = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
  completeMeetingMock: vi.fn(),
  updateMeetingMock: vi.fn(),
  generateTextMock: vi.fn(),
  createConversationMock: vi.fn(),
  createChatMessageMock: vi.fn(),
  emitEventMock: vi.fn(),
}));

let persistenceAllowed = true;

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("../features/featureFlags", () => ({
  isExpansionFeatureEnabled: () => true,
}));
vi.mock("../utils/incognito.utils", () => ({
  isPersistenceAllowed: () => persistenceAllowed,
}));
vi.mock("../repos", () => ({
  getMeetingRepo: () => ({
    getMeeting: async () => ({
      id: "meeting-1",
      title: "Weekly sync",
      transcript: "hello",
    }),
    completeMeeting: completeMeetingMock,
    updateMeeting: updateMeetingMock,
  }),
  getWebhookRepo: () => ({
    emitEvent: emitEventMock,
  }),
  getGenerateTextRepo: () => ({
    warnings: [] as string[],
    repo: { generateText: generateTextMock },
  }),
}));
vi.mock("./chat.actions", () => ({
  createConversation: createConversationMock,
  createChatMessage: createChatMessageMock,
}));

const segment = (text: string, endTimeMs: number): MeetingSegment => ({
  id: "seg-1",
  meetingId: "meeting-1",
  speakerId: "spk-1",
  startTimeMs: 0,
  endTimeMs,
  text,
});

describe("generateMeetingSummary failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistenceAllowed = true;
    generateTextMock.mockRejectedValue(
      new Error("boom sk-abcdefghijklmnopqrstuvwxyz123456"),
    );
  });

  it("logs the redacted message instead of [object Promise]", async () => {
    await generateMeetingSummary("meeting-1");

    expect(loggerMock.warning).toHaveBeenCalledTimes(1);
    const message = String(loggerMock.warning.mock.calls[0]?.[0]);
    expect(message).toContain(
      "Summary generation failed for meeting meeting-1:",
    );
    expect(message).not.toContain("[object Promise]");
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(message).toContain("[redacted-secret]");
  });

  it("skips generation when persistence is suppressed mid-flight", async () => {
    persistenceAllowed = false;
    generateTextMock.mockResolvedValue({ text: "summary" });

    await generateMeetingSummary("meeting-1");

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(updateMeetingMock).not.toHaveBeenCalled();
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("Skipping meeting summary"),
    );
  });

  it("skips the persist when persistence is suppressed after generation", async () => {
    generateTextMock.mockImplementation(async () => {
      persistenceAllowed = false;
      return { text: "summary" };
    });

    await generateMeetingSummary("meeting-1");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(updateMeetingMock).not.toHaveBeenCalled();
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("Skipping meeting summary persist"),
    );
  });
});

describe("stopMeetingRecording conversation creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistenceAllowed = true;
    completeMeetingMock.mockResolvedValue(undefined);
    createConversationMock.mockImplementation(async (c) => c);
  });

  it("creates the meeting conversation after completion", async () => {
    await stopMeetingRecording("meeting-1", [segment("hello", 1200)], []);

    expect(completeMeetingMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Weekly sync" }),
    );
    expect(emitEventMock).toHaveBeenCalledWith(
      "meeting.completed",
      expect.objectContaining({ id: "meeting-1" }),
    );
    expect(completeMeetingMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      createConversationMock.mock.invocationCallOrder[0] ?? 1,
    );
  });

  it("surfaces conversation failure without losing the completion", async () => {
    createConversationMock.mockRejectedValue(new Error("db full"));

    await expect(
      stopMeetingRecording("meeting-1", [segment("hello", 1200)], []),
    ).rejects.toThrow("db full");
    expect(completeMeetingMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("Meeting conversation creation failed"),
    );
  });
});

describe("createMeetingConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistenceAllowed = true;
    createConversationMock.mockImplementation(async (c) => c);
  });

  it("titles the conversation after the meeting", async () => {
    const result = await createMeetingConversation("meeting-1");

    expect(createConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Weekly sync" }),
    );
    expect(result).toEqual(expect.objectContaining({ title: "Weekly sync" }));
  });

  it("pre-populates the conversation with the transcript context", async () => {
    await createMeetingConversation("meeting-1");

    expect(createChatMessageMock).toHaveBeenCalledTimes(1);
    expect(createChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        content: "hello",
        metadata: { meetingId: "meeting-1" },
      }),
    );
  });
});
