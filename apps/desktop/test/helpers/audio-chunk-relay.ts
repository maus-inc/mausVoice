import { createRecordingAudioRelay } from "../../src/sessions/recording-audio-relay";
import type { TranscriptionSession } from "../../src/types/transcription-session.types";

/**
 * Registers a session's `audio_chunk` stream and hands it the relay, the way a
 * capture entry point must: before `start_recording`, so the recorder's first
 * tick is never lost. Returns the relay so a test can drop audio into it
 * before the session binds, which is what a slow session start looks like.
 */
export const openAudioChunkStreamFor = async (
  session: TranscriptionSession,
) => {
  const relay = createRecordingAudioRelay();
  await relay.attach();
  session.attachAudioChunkRelay?.(relay);
  return relay;
};
