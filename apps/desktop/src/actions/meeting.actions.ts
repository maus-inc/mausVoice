import {
  Meeting,
  MeetingSegment,
  MeetingSpeaker,
} from "../types/meetings.types";
import type { Conversation } from "@maus-inc/types";
import { getGenerateTextRepo, getMeetingRepo } from "../repos";
import type { MeetingExportFormat } from "../repos/meeting.repo";
import { createChatMessage, createConversation } from "./chat.actions";
import { createId } from "../utils/id.utils";
import { isExpansionFeatureEnabled } from "../features/featureFlags";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";
import { redactError } from "../utils/redaction.utils";

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

  await repo.completeMeeting({
    id: meetingId,
    status: "completed",
    durationMs,
    transcript,
    segments,
    speakers,
  });

  await createMeetingConversation(meetingId);
};

export const createMeetingConversation = async (
  meetingId: string,
): Promise<Conversation> => {
  ensureMeetingNotesEnabled();
  ensurePersistenceAllowed();
  const repo = getMeetingRepo();
  const meeting = await repo.getMeeting(meetingId);
  const now = new Date().toISOString();
  try {
    const conversation = await createConversation({
      id: createId(),
      title: meeting.title,
      createdAt: now,
      updatedAt: now,
    });
    if (meeting.transcript) {
      await createChatMessage({
        id: createId(),
        conversationId: conversation.id,
        role: "system",
        content: meeting.transcript,
        createdAt: now,
        metadata: { meetingId },
      });
    }
    return conversation;
  } catch (err) {
    const redacted = await redactError(err);
    getLogger().warning(
      `Meeting conversation creation failed for meeting ${meetingId}: ${redacted}`,
    );
    throw err;
  }
};

export const searchMeetings = async (
  query: string,
  limit = 20,
): Promise<Meeting[]> => {
  ensureMeetingNotesEnabled();
  return getMeetingRepo().searchMeetings(query, limit);
};

export const exportMeeting = async (
  id: string,
  format: MeetingExportFormat,
): Promise<boolean> => {
  ensureMeetingNotesEnabled();
  return getMeetingRepo().exportMeeting(id, format);
};

export const generateMeetingSummary = async (
  meetingId: string,
): Promise<void> => {
  ensureMeetingNotesEnabled();
  if (!isPersistenceAllowed()) {
    getLogger().warning(
      `Skipping meeting summary in incognito mode for meeting ${meetingId}`,
    );
    return;
  }
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

  let output;
  try {
    if (!isPersistenceAllowed()) {
      getLogger().warning(
        `Skipping meeting summary: persistence suppressed for meeting ${meetingId}`,
      );
      return;
    }
    output = await genRepo.generateText({
      system:
        "You are a meeting assistant. Given the transcript of a meeting, produce a concise summary capturing the key discussion points, decisions, and action items.",
      prompt: meeting.transcript,
    });
  } catch (err) {
    const redacted = await redactError(err);
    getLogger().warning(
      `Summary generation failed for meeting ${meetingId}: ${redacted}`,
    );
    return;
  }

  const summary = output.text.trim();

  if (!summary) {
    getLogger().warning(
      `Summary generation returned empty for meeting ${meetingId}`,
    );
    return;
  }

  if (!isPersistenceAllowed()) {
    getLogger().warning(
      `Skipping meeting summary persist: persistence suppressed for meeting ${meetingId}`,
    );
    return;
  }

  await repo.updateMeeting({
    id: meetingId,
    summary,
  });
};
