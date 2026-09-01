export type MeetingStatus =
  "idle" | "recording" | "processing" | "completed" | "failed";

export type Meeting = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  title: string | null;
  status: MeetingStatus;
  transcript: string | null;
  summary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  isDeleted: boolean;
};

export type MeetingSummary = {
  id: string;
  meetingId: string;
  content: string;
  generatedAt: string;
};
