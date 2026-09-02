import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMeetingRepo, type UpdateMeetingParams } from "./meeting.repo";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

const sampleMeeting = {
  id: "meeting-1",
  createdAt: "2026-09-02T10:00:00.000Z",
  title: "Sprint planning",
  durationMs: 0,
  status: "recording" as const,
  speakers: [],
  segments: [],
  summary: undefined,
  transcript: "",
  source: "microphone" as const,
};

const sampleSegment = {
  id: "segment-1",
  meetingId: "meeting-1",
  speakerId: "speaker-1",
  startTimeMs: 0,
  endTimeMs: 1000,
  text: "hello",
  confidence: 0.9,
};

const sampleSpeaker = {
  id: "speaker-1",
  meetingId: "meeting-1",
  name: "Alice",
  label: "A",
};

describe("LocalMeetingRepo payload shape", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("wraps meeting_update fields in an args payload", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const repo = new LocalMeetingRepo();
    const params: UpdateMeetingParams = {
      id: "meeting-1",
      status: "completed",
      durationMs: 1234,
      transcript: "hello",
    };
    await repo.updateMeeting(params);
    expect(invokeMock).toHaveBeenCalledWith("meeting_update", {
      args: params,
    });
  });

  it("preserves a caller-supplied segment id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const repo = new LocalMeetingRepo();
    await repo.insertSegments("meeting-1", [sampleSegment]);
    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { segments: Array<{ id: string }> },
    ];
    expect(payload.segments[0].id).toBe("segment-1");
  });

  it("generates an id when the segment omits one", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const repo = new LocalMeetingRepo();
    await repo.insertSegments("meeting-1", [{ ...sampleSegment, id: "" }]);
    const [, payload] = invokeMock.mock.calls[0] as [
      string,
      { segments: Array<{ id: string }> },
    ];
    expect(payload.segments[0].id).toBeTruthy();
    expect(payload.segments[0].id).not.toBe("");
  });

  it("sends completeMeeting with meetingId and children wrapped in args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const repo = new LocalMeetingRepo();
    await repo.completeMeeting({
      id: "meeting-1",
      status: "completed",
      durationMs: 1000,
      transcript: "hello",
      segments: [sampleSegment],
      speakers: [sampleSpeaker],
    });
    expect(invokeMock).toHaveBeenCalledWith("meeting_complete", {
      args: {
        meetingId: "meeting-1",
        title: undefined,
        status: "completed",
        summary: undefined,
        transcript: "hello",
        durationMs: 1000,
        segments: [
          expect.objectContaining({ id: "segment-1", meetingId: "meeting-1" }),
        ],
        speakers: [
          expect.objectContaining({ id: "speaker-1", meetingId: "meeting-1" }),
        ],
      },
    });
  });
});

describe("LocalMeetingRepo boundary conversion", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("converts an ISO createdAt to a number and back", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "meeting-1",
      createdAt: 1700000000000,
      title: "Sprint planning",
      durationMs: 0,
      status: "recording",
      summary: null,
      transcript: "",
      source: "microphone",
    });
    const repo = new LocalMeetingRepo();
    const result = await repo.createMeeting(sampleMeeting);
    expect(result.createdAt).toBe("2023-11-14T22:13:20.000Z");
  });
});
