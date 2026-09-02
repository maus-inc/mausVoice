import {
  Meeting,
  MeetingSegment,
  MeetingSpeaker,
} from "../types/meetings.types";
import { getGenerateTextRepo, getMeetingRepo } from "../repos";
import { createId } from "../utils/id.utils";
import { isExpansionFeatureEnabled } from "../features/featureFlags";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";

const ensureMeetingNotesEnabled = (): void => {
  if (!isExpansionFeatureEnabled("meetingNotesEnabled")) {
    throw new Error("Meeting notes feature is not enabled");
  }
};

const ensurePersistenceAllowed = (): void => {
  if (!isPersistenceAllowed()) {
    throw new Error("Persistence is suppressed in incognito mode");
  }
};

export const startMeetingRecording = async (
  title: string,
): Promise<Meeting> => {
  ensureMeetingNotesEnabled();
  ensurePersistenceAllowed();
  const repo = getMeetingRepo();
  return repo.createMeeting({
    id: createId(),
    createdAt: new Date().toISOString(),
    title,
    durationMs: 0,
    status: "recording",
    speakers: [],
    segments: [],
    summary: undefined,
    transcript: "",
    source: "microphone",
  });
};

export const stopMeetingRecording = async (
  meetingId: string,
  segments: MeetingSegment[],
  speakers: MeetingSpeaker[],
): Promise<void> => {
  ensureMeetingNotesEnabled();
  ensurePersistenceAllowed();
  const repo = getMeetingRepo();

  const durationMs =
    segments.length > 0 ? Math.max(...segments.map((s) => s.endTimeMs)) : 0;

  const transcript = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n");

  if (segments.length > 0) {
    await repo.insertSegments(meetingId, segments);
  }

  if (speakers.length > 0) {
    await repo.insertSpeakers(meetingId, speakers);
  }

  await repo.updateMeeting({
    id: meetingId,
    status: "completed",
    durationMs,
    transcript,
  });
};

export const generateMeetingSummary = async (
  meetingId: string,
): Promise<void> => {
  ensureMeetingNotesEnabled();
  const repo = getMeetingRepo();
  const meeting = await repo.getMeeting(meetingId);

  if (!meeting.transcript) {
    getLogger().warning(
      `Meeting ${meetingId} has no transcript, skipping summary generation`,
    );
    return;
  }

  const { repo: genRepo, warnings } = getGenerateTextRepo();

  if (warnings.length > 0) {
    getLogger().warning(`Summary generation warnings: ${warnings.join("; ")}`);
  }

  if (!genRepo) {
    getLogger().warning("No generate-text repo available for meeting summary");
    return;
  }

  const output = await genRepo.generateText({
    system:
      "You are a meeting assistant. Given the transcript of a meeting, produce a concise summary capturing the key discussion points, decisions, and action items.",
    prompt: meeting.transcript,
  });

  const summary = output.text.trim();

  if (!summary) {
    getLogger().warning(
      `Summary generation returned empty for meeting ${meetingId}`,
    );
    return;
  }

  if (!isPersistenceAllowed()) {
    getLogger().warning(
      `Skipping summary persistence in incognito mode for meeting ${meetingId}`,
    );
    return;
  }

  await repo.updateMeeting({
    id: meetingId,
    summary,
  });
};
