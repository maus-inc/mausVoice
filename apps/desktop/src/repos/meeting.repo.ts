import {
  Meeting,
  MeetingSegment,
  MeetingSpeaker,
} from "../types/meetings.types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import { createId } from "../utils/id.utils";
import { BaseRepo } from "./base.repo";

type LocalMeeting = {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  status: string;
  summary: string | null;
  transcript: string;
  source: string;
};

type LocalMeetingWithDetails = LocalMeeting & {
  segments: LocalMeetingSegment[];
  speakers: LocalMeetingSpeaker[];
};

type LocalMeetingSegment = {
  id: string;
  meetingId: string;
  speakerId: string;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  confidence: number | null;
};

type LocalMeetingSpeaker = {
  id: string;
  meetingId: string;
  name: string;
  label: string | null;
};

const toLocalMeeting = (meeting: Meeting): LocalMeeting => ({
  id: meeting.id,
  title: meeting.title,
  createdAt: dayjs(meeting.createdAt).valueOf(),
  durationMs: meeting.durationMs,
  status: meeting.status,
  summary: meeting.summary ?? null,
  transcript: meeting.transcript,
  source: meeting.source,
});

const fromLocalMeeting = (local: LocalMeeting): Meeting => ({
  id: local.id,
  createdAt: dayjs(local.createdAt).toISOString(),
  title: local.title,
  durationMs: local.durationMs,
  status: local.status as Meeting["status"],
  speakers: [],
  segments: [],
  summary: local.summary ?? undefined,
  transcript: local.transcript,
  source: local.source as Meeting["source"],
});

const fromLocalMeetingWithDetails = (
  local: LocalMeetingWithDetails,
): Meeting => ({
  ...fromLocalMeeting(local),
  segments: local.segments.map(fromLocalSegment),
  speakers: local.speakers.map(fromLocalSpeaker),
});

const fromLocalSegment = (local: LocalMeetingSegment): MeetingSegment => ({
  id: local.id,
  meetingId: local.meetingId,
  speakerId: local.speakerId,
  startTimeMs: local.startTimeMs,
  endTimeMs: local.endTimeMs,
  text: local.text,
  confidence: local.confidence ?? undefined,
});

const toLocalSegment = (
  meetingId: string,
  segment: MeetingSegment,
): LocalMeetingSegment => ({
  id: createId(),
  meetingId,
  speakerId: segment.speakerId,
  startTimeMs: segment.startTimeMs,
  endTimeMs: segment.endTimeMs,
  text: segment.text,
  confidence: segment.confidence ?? null,
});

const fromLocalSpeaker = (local: LocalMeetingSpeaker): MeetingSpeaker => ({
  id: local.id,
  meetingId: local.meetingId,
  name: local.name,
  label: local.label ?? undefined,
});

const toLocalSpeaker = (
  meetingId: string,
  speaker: MeetingSpeaker,
): LocalMeetingSpeaker => ({
  id: speaker.id,
  meetingId,
  name: speaker.name,
  label: speaker.label ?? null,
});

export type UpdateMeetingParams = {
  id: string;
  title?: string;
  status?: string;
  summary?: string | null;
  transcript?: string;
  durationMs?: number;
};

export abstract class BaseMeetingRepo extends BaseRepo {
  abstract createMeeting(meeting: Meeting): Promise<Meeting>;
  abstract getMeeting(id: string): Promise<Meeting>;
  abstract listMeetings(limit?: number): Promise<Meeting[]>;
  abstract updateMeeting(params: UpdateMeetingParams): Promise<void>;
  abstract deleteMeeting(id: string): Promise<void>;
  abstract insertSegments(
    meetingId: string,
    segments: MeetingSegment[],
  ): Promise<void>;
  abstract insertSpeakers(
    meetingId: string,
    speakers: MeetingSpeaker[],
  ): Promise<void>;
}

export class LocalMeetingRepo extends BaseMeetingRepo {
  async createMeeting(meeting: Meeting): Promise<Meeting> {
    const stored = await invoke<LocalMeeting>("meeting_create", {
      meeting: toLocalMeeting(meeting),
    });
    return fromLocalMeeting(stored);
  }

  async getMeeting(id: string): Promise<Meeting> {
    const stored = await invoke<LocalMeetingWithDetails>("meeting_get", {
      id,
    });
    return fromLocalMeetingWithDetails(stored);
  }

  async listMeetings(limit = 20): Promise<Meeting[]> {
    const stored = await invoke<LocalMeeting[]>("meeting_list", {
      limit,
    });
    return stored.map(fromLocalMeeting);
  }

  async updateMeeting(params: UpdateMeetingParams): Promise<void> {
    await invoke<void>("meeting_update", {
      args: {
        id: params.id,
        title: params.title,
        status: params.status,
        summary: params.summary,
        transcript: params.transcript,
        durationMs: params.durationMs,
      },
    });
  }

  async deleteMeeting(id: string): Promise<void> {
    await invoke<void>("meeting_delete", { id });
  }

  async insertSegments(
    meetingId: string,
    segments: MeetingSegment[],
  ): Promise<void> {
    const locals = segments.map((segment) =>
      toLocalSegment(meetingId, segment),
    );
    await invoke<void>("meeting_segment_insert", { segments: locals });
  }

  async insertSpeakers(
    meetingId: string,
    speakers: MeetingSpeaker[],
  ): Promise<void> {
    const locals = speakers.map((speaker) =>
      toLocalSpeaker(meetingId, speaker),
    );
    await invoke<void>("meeting_speaker_insert", { speakers: locals });
  }
}
