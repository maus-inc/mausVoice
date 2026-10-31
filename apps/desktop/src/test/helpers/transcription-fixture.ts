import type { Transcription } from "@maus-inc/types";

/** Shared saved-transcription fixture for action and persistence tests. */
export const sampleTranscription = (id: string): Transcription => ({
  id,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "hello",
  isDeleted: false,
  audio: { filePath: `/tmp/${id}.wav`, durationMs: 1000 },
});
