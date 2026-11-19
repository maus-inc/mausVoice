export type MeetingSpeaker = {
  id: string;
  name: string;
  label?: string;
};

export type MeetingSegment = {
  speakerId: string;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  confidence?: number;
};

export type MeetingStatus =
  "idle" | "recording" | "processing" | "completed" | "failed";

export type Meeting = {
  id: string;
  createdAt: string;
  title: string;
  durationMs: number;
  status: MeetingStatus;
  speakers: MeetingSpeaker[];
  segments: MeetingSegment[];
  summary?: string;
  transcript: string;
  source: "microphone" | "system" | "mixed";
};

export type MeetingSummaryTemplate = {
  id: string;
  name: string;
  prompt: string;
};

export type MeetingExportFormat = "txt" | "md" | "srt" | "vtt" | "json";
