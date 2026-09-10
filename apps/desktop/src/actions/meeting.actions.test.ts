import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMeetingSummary } from "./meeting.actions";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("../features/featureFlags", () => ({
  isExpansionFeatureEnabled: () => true,
}));
vi.mock("../utils/incognito.utils", () => ({
  isPersistenceAllowed: () => true,
}));
vi.mock("../repos", () => ({
  getMeetingRepo: () => ({
    getMeeting: async () => ({ id: "meeting-1", transcript: "hello" }),
  }),
  getGenerateTextRepo: () => ({
    warnings: [] as string[],
    repo: {
      generateText: async () => {
        throw new Error("boom sk-abcdefghijklmnopqrstuvwxyz123456");
      },
    },
  }),
}));

describe("generateMeetingSummary failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
