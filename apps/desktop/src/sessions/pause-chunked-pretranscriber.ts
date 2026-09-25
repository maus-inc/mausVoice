import type { TranscribeAudioMetadata } from "../actions/transcribe.actions";
import type { StopRecordingResponse } from "../types/transcription-session.types";

export type PretranscribedChunk = {
  text: string;
  metadata: TranscribeAudioMetadata;
  warnings: string[];
};

export type ChunkTranscriber = (
  samples: Float32Array,
  sampleRate: number,
) => Promise<PretranscribedChunk>;

export type PauseChunkingConfig = {
  /** Never cut before this much audio is pending, so each request keeps context. */
  minChunkSec: number;
  /** A low-energy run this long is treated as a sentence/phrase pause. */
  minPauseMs: number;
};

export type PretranscriptionResult = PretranscribedChunk & {
  chunkCount: number;
};

const FRAME_MS = 30;
const ABSOLUTE_SILENCE_RMS = 0.0035;
const NOISE_FLOOR_MULTIPLIER = 3;
/** A pause must also sit at least 20 dB below the recent speech level. */
const SPEECH_LEVEL_RATIO = 0.1;
const FLOOR_RISE = 0.0005;
const PEAK_DECAY = 0.9995;
const PROBE_LENGTH = 32;

const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;

/**
 * Join transcripts of consecutive, non-overlapping audio spans. Scripts that
 * are written without inter-word spaces (CJK, Thai, Lao, Khmer, Burmese) join
 * directly; everything else joins with a single space.
 */
export const joinTranscriptSpans = (spans: string[]): string =>
  spans.reduce((joined, span) => {
    const next = span.trim();
    if (!next) return joined;
    if (!joined) return next;
    const needsSpace = !(
      NO_SPACE_SCRIPT.test(joined.slice(-1)) || NO_SPACE_SCRIPT.test(next[0])
    );
    return needsSpace ? `${joined} ${next}` : `${joined}${next}`;
  }, "");

type CommittedChunk = {
  endOffset: number;
  probe: Float32Array;
};

/**
 * Transcribes finished stretches of speech while the user is still talking.
 *
 * Live audio is split only at natural pauses once `minChunkSec` has
 * accumulated, and each span is sent to `transcribe` in order. At stop,
 * only the audio after the last cut is still untranscribed, so the wait
 * after the user stops is bounded by the tail length instead of the whole
 * recording.
 *
 * `finish` returns `null` whenever the result could differ from a single
 * whole-recording request (no cut happened, a span failed, or the live
 * stream does not match the final recording). The caller then transcribes
 * the full recording exactly as before.
 */
export class PauseChunkedPretranscriber {
  private buffer = new Float32Array(0);
  private bufferLength = 0;
  private analyzedLength = 0;
  private silentRunStart: number | null = null;
  private noiseFloor: number | null = null;
  private speechLevel = 0;
  private committedOffset = 0;
  private readonly committed: CommittedChunk[] = [];
  private readonly results: Promise<PretranscribedChunk>[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private sealed = false;
  private disposed = false;
  private readonly frameSamples: number;
  private readonly minChunkSamples: number;
  private readonly minPauseSamples: number;

  constructor(
    private readonly sampleRate: number,
    private readonly transcribe: ChunkTranscriber,
    config: PauseChunkingConfig,
  ) {
    this.frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.minChunkSamples = Math.round(sampleRate * config.minChunkSec);
    this.minPauseSamples = Math.round((sampleRate * config.minPauseMs) / 1000);
  }

  get chunkCount(): number {
    return this.committed.length;
  }

  push(samples: ArrayLike<number>): void {
    if (this.sealed || this.failed || samples.length === 0) return;
    this.append(samples);
    this.analyzeFrames();
  }

  async finish(
    audio: StopRecordingResponse,
  ): Promise<PretranscriptionResult | null> {
    this.sealed = true;
    if (this.disposed || this.committed.length === 0) return null;
    if (audio.sampleRate !== this.sampleRate) return null;
    const samples =
      audio.samples instanceof Float32Array
        ? audio.samples
        : Float32Array.from(audio.samples);
    if (!this.matchesCommittedAudio(samples)) return null;

    const tail = samples.subarray(this.committedOffset);
    const tailResult = tail.length > 0 ? this.enqueue(tail.slice()) : null;
    let chunks: PretranscribedChunk[];
    try {
      chunks = await Promise.all(
        tailResult ? [...this.results, tailResult] : this.results,
      );
    } catch {
      return null;
    }
    if (this.failed || this.disposed) return null;

    const last = chunks[chunks.length - 1];
    return {
      text: joinTranscriptSpans(chunks.map((chunk) => chunk.text)),
      metadata: last.metadata,
      warnings: Array.from(new Set(chunks.flatMap((chunk) => chunk.warnings))),
      chunkCount: chunks.length,
    };
  }

  dispose(): void {
    this.sealed = true;
    this.disposed = true;
    this.buffer = new Float32Array(0);
    this.bufferLength = 0;
  }

  private append(samples: ArrayLike<number>): void {
    const required = this.bufferLength + samples.length;
    if (required > this.buffer.length) {
      const grown = new Float32Array(
        Math.max(required, this.buffer.length * 2),
      );
      grown.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = grown;
    }
    this.buffer.set(samples, this.bufferLength);
    this.bufferLength = required;
  }

  private analyzeFrames(): void {
    while (this.analyzedLength + this.frameSamples <= this.bufferLength) {
      const frameStart = this.analyzedLength;
      const frameEnd = frameStart + this.frameSamples;
      const rms = this.frameRms(frameStart, frameEnd);
      this.analyzedLength = frameEnd;

      if (this.isSilent(rms)) {
        this.silentRunStart ??= frameStart;
        const runLength = frameEnd - this.silentRunStart;
        const cut = this.silentRunStart + Math.floor(runLength / 2);
        if (runLength >= this.minPauseSamples && cut >= this.minChunkSamples) {
          this.commit(cut);
        }
      } else {
        this.silentRunStart = null;
      }
    }
  }

  private frameRms(start: number, end: number): number {
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const value = this.buffer[index];
      sum += value * value;
    }
    return Math.sqrt(sum / (end - start));
  }

  /**
   * Energy VAD with two trackers: a noise floor that falls fast and rises
   * slowly, and a speech level that rises fast and decays slowly. Requiring
   * both keeps a recording that starts mid-sentence (floor seeded by speech)
   * or a long monologue (floor creeping upward) from being cut mid-word.
   */
  private isSilent(rms: number): boolean {
    this.speechLevel = Math.max(rms, this.speechLevel * PEAK_DECAY);
    if (this.noiseFloor === null) {
      this.noiseFloor = rms;
    } else if (rms < this.noiseFloor) {
      this.noiseFloor = (this.noiseFloor + rms) / 2;
    } else {
      this.noiseFloor += (rms - this.noiseFloor) * FLOOR_RISE;
    }
    const floorThreshold = Math.max(
      ABSOLUTE_SILENCE_RMS,
      this.noiseFloor * NOISE_FLOOR_MULTIPLIER,
    );
    return rms < floorThreshold && rms < this.speechLevel * SPEECH_LEVEL_RATIO;
  }

  private commit(cut: number): void {
    const span = this.buffer.slice(0, cut);
    this.committedOffset += cut;
    this.committed.push({
      endOffset: this.committedOffset,
      probe: span.slice(Math.max(0, span.length - PROBE_LENGTH)),
    });
    this.results.push(this.enqueue(span));

    this.buffer.copyWithin(0, cut, this.bufferLength);
    this.bufferLength -= cut;
    this.analyzedLength -= cut;
    this.silentRunStart = null;
  }

  private enqueue(span: Float32Array): Promise<PretranscribedChunk> {
    const result = this.queue.then(() =>
      this.transcribe(span, this.sampleRate),
    );
    this.queue = result.catch(() => {
      this.failed = true;
    });
    return result;
  }

  /**
   * The live `audio_chunk` stream and the recorder buffer are fed from the
   * same capture callback, so committed spans must be an exact prefix of the
   * final recording. Verify the end of every committed span before trusting
   * the incremental transcripts.
   */
  private matchesCommittedAudio(samples: Float32Array): boolean {
    if (samples.length < this.committedOffset) return false;
    return this.committed.every(({ endOffset, probe }) => {
      const start = endOffset - probe.length;
      for (let index = 0; index < probe.length; index += 1) {
        if (samples[start + index] !== probe[index]) return false;
      }
      return true;
    });
  }
}
