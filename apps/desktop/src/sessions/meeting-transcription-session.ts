import { getAppState } from "../store";
import type { MeetingSegment, MeetingSpeaker } from "../types/meetings.types";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { createId } from "../utils/id.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import {
  type DeepgramStreamingWord,
  startDeepgramStreaming,
} from "./deepgram-transcription-session";

export type MeetingTimedWord = {
  text: string;
  startMs: number;
  endMs: number;
  speaker: number | null;
  confidence?: number;
};

const UNKNOWN_SPEAKER_ID = "speaker-unknown";

const speakerIdFor = (speaker: number | null): string =>
  speaker === null ? UNKNOWN_SPEAKER_ID : `speaker-${speaker}`;

const speakerNameFor = (speaker: number | null): string =>
  speaker === null ? "Unknown speaker" : `Speaker ${speaker + 1}`;

export const groupWordsIntoSegments = (
  words: MeetingTimedWord[],
): { segments: MeetingSegment[]; speakers: MeetingSpeaker[] } => {
  const segments: MeetingSegment[] = [];
  const seenSpeakers = new Map<number | null, MeetingSpeaker>();

  const trackSpeaker = (speaker: number | null): string => {
    const id = speakerIdFor(speaker);
    if (!seenSpeakers.has(speaker)) {
      seenSpeakers.set(speaker, {
        id,
        meetingId: "",
        name: speakerNameFor(speaker),
      });
    }
    return id;
  };

  let current: MeetingTimedWord[] = [];
  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const first = current[0];
    const last = current[current.length - 1];
    const confidences = current
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");
    segments.push({
      id: createId(),
      meetingId: "",
      speakerId: trackSpeaker(first.speaker),
      startTimeMs: first.startMs,
      endTimeMs: last.endMs,
      text: current.map((w) => w.text).join(" "),
      confidence:
        confidences.length > 0
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : undefined,
    });
    current = [];
  };

  for (const word of words) {
    if (current.length > 0 && current[0].speaker !== word.speaker) {
      flush();
    }
    current.push(word);
  }
  flush();

  return { segments, speakers: [...seenSpeakers.values()] };
};

export class MeetingTranscriptionSession implements TranscriptionSession {
  private session: Awaited<ReturnType<typeof startDeepgramStreaming>> | null =
    null;
  private startupPromise: Promise<void> | null = null;
  private apiKey: string;
  private interimCallback: ((segment: string) => void) | null = null;
  private words: MeetingTimedWord[] = [];

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: (segment: string) => void): void {
    this.interimCallback = callback;
  }

  getSegments(): MeetingSegment[] {
    return groupWordsIntoSegments(this.words).segments;
  }

  getSpeakers(): MeetingSpeaker[] {
    return groupWordsIntoSegments(this.words).speakers;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);

        this.session = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          this.interimCallback ?? undefined,
          {
            diarize: true,
            onWords: (incoming: DeepgramStreamingWord[]) => {
              for (const w of incoming) {
                const text = w.punctuated_word ?? w.word ?? "";
                if (
                  !text ||
                  typeof w.start !== "number" ||
                  typeof w.end !== "number"
                ) {
                  continue;
                }
                this.words.push({
                  text,
                  startMs: Math.round(w.start * 1000),
                  endMs: Math.round(w.end * 1000),
                  speaker: typeof w.speaker === "number" ? w.speaker : null,
                  confidence: w.confidence,
                });
              }
            },
          },
        );
      } catch (error) {
        console.error("[Meeting] Failed to start streaming:", error);
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (this.startupPromise) {
      await this.startupPromise;
    }

    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • Deepgram (Meeting)",
          transcriptionMode: "api",
        },
        warnings: ["Meeting streaming session was not established"],
      };
    }

    try {
      const transcript = await this.session.finalize();
      return {
        rawTranscript: transcript || null,
        metadata: {
          inferenceDevice: "API • Deepgram (Meeting)",
          transcriptionMode: "api",
        },
        warnings: [],
      };
    } catch (error) {
      console.error("[Meeting] Failed to finalize session:", error);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • Deepgram (Meeting)",
          transcriptionMode: "api",
        },
        warnings: [
          `Meeting finalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
      };
    }
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
    this.words = [];
  }
}
