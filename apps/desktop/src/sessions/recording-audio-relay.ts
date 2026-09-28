import type { UnlistenFn } from "@tauri-apps/api/event";
import { getLogger } from "../utils/log.utils";
import type { TranscriptionSession } from "../types/transcription-session.types";
import { listenToAudioChunks } from "./audio-chunk-events";

/** `offset` is the recording index of `samples[0]`, or null when unalignable. */
export type AudioChunkSink = (samples: number[], offset: number | null) => void;

type BufferedChunk = { samples: number[]; offset: number | null };

/**
 * Ceiling on what a relay holds while no session is bound, in samples at the
 * highest rate the recorder produces. It lets a slow session start (a model
 * download) buffer half a minute of speech at 48 kHz, and proportionally
 * longer at a lower rate, without the buffer growing without bound. Past the
 * ceiling the live stream has a permanent hole, so `bind` reports the loss and
 * the session transcribes the whole recording, which is what a late listener
 * already costs today.
 */
export const MAX_BUFFERED_SAMPLES = 30 * 48_000;

/**
 * The recorder's live sample stream, owned by the capture entry point.
 *
 * `audio_chunk` is only emitted once `start_recording` has run: the emitter
 * and its offset counter are created there, and every platform starts ticking
 * only after the recorder is open. A listener registered afterwards misses
 * whatever the user already spoke, so a relay is registered *before* capture
 * starts and holds those early chunks until the session binds a sink to it.
 * The wait a session needs to warm up (a model download) then delays
 * transcription without touching a sample.
 *
 * Ownership: the entry point creates and attaches the relay, then hands it to
 * the session with `TranscriptionSession.attachAudioChunkRelay`, and the
 * session releases it in `cleanup()`. `release` is idempotent so a failed
 * start can release defensively.
 */
export class RecordingAudioRelay {
  private sink: AudioChunkSink | null = null;
  private buffered: BufferedChunk[] = [];
  private bufferedSamples = 0;
  private overflowed = false;
  private unlisten: UnlistenFn | null = null;
  private released = false;

  /**
   * Registers `audio_chunk`. Must be awaited before `start_recording`, which
   * is the whole point of the relay.
   */
  async attach(): Promise<void> {
    if (this.released) throw new Error("Audio relay already released");
    if (this.unlisten) return;
    this.unlisten = await listenToAudioChunks((samples, offset) =>
      this.receive(samples, offset),
    );
  }

  /** Samples held for a sink that has not bound yet. */
  get bufferedSampleCount(): number {
    return this.bufferedSamples;
  }

  /**
   * Hands the stream to `sink`, replaying in arrival order every chunk that
   * arrived first. Returns false when the buffer overflowed, which means the
   * live stream has a hole: the caller must drop a pretranscriber rather than
   * infer a recording it cannot cover.
   */
  bind(sink: AudioChunkSink): boolean {
    this.sink = sink;
    if (this.overflowed) return false;
    const buffered = this.buffered;
    this.buffered = [];
    this.bufferedSamples = 0;
    for (const chunk of buffered) sink(chunk.samples, chunk.offset);
    return true;
  }

  /**
   * Stops forwarding live chunks, keeping the listener registered and the
   * buffer intact: a session that re-arms itself for a recording unbinds
   * first, and the audio waiting for it is still the only copy.
   */
  unbind(): void {
    this.sink = null;
  }

  /** Unregisters the listener and drops the buffer. Safe to call twice. */
  release(): void {
    this.released = true;
    this.sink = null;
    this.buffered = [];
    this.bufferedSamples = 0;
    this.unlisten?.();
    this.unlisten = null;
  }

  private receive(samples: number[], offset: number | null): void {
    if (this.released) return;
    if (this.sink) {
      this.sink(samples, offset);
      return;
    }
    this.bufferedSamples += samples.length;
    if (this.bufferedSamples > MAX_BUFFERED_SAMPLES) {
      this.overflowed = true;
      this.buffered = [];
      this.bufferedSamples = 0;
      return;
    }
    this.buffered.push({ samples, offset });
  }
}

export const createRecordingAudioRelay = (): RecordingAudioRelay =>
  new RecordingAudioRelay();

/**
 * Runs `startCapture` with the session's audio_chunk stream already
 * registered.
 *
 * The relay is opened before the capture call rather than inside the session,
 * because the recorder's emitter only exists once capture starts. A session
 * that does not read the live stream gets no listener at all. A relay that
 * fails to register is dropped instead of failing the dictation: the session
 * still has the whole recording at stop, which is the path it falls back to
 * anyway.
 */
export const startCaptureWithSessionAudio = async <T>(
  session: TranscriptionSession,
  startCapture: () => Promise<T>,
): Promise<T> => {
  if (session.consumesAudioChunkRelay) {
    const relay = createRecordingAudioRelay();
    try {
      await relay.attach();
      session.attachAudioChunkRelay?.(relay);
    } catch (error) {
      getLogger().warning(
        `Audio chunk stream unavailable, transcribing the whole recording (${error})`,
      );
      relay.release();
    }
  }
  return startCapture();
};
