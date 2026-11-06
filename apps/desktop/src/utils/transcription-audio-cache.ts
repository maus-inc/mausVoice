import type { TranscriptionAudioData } from "../repos/transcription.repo";

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_ENTRIES = 4;
const AUDIO_TTL_MS = 60_000;

type Entry = {
  promise: Promise<TranscriptionAudioData>;
  bytes: number;
  loadedAt: number | null;
};

export class TranscriptionAudioCache {
  private entries = new Map<string, Entry>();
  private pendingLoads = 0;

  constructor(
    private readonly maxBytes = MAX_AUDIO_BYTES,
    private readonly now = Date.now,
  ) {}

  invalidate(id?: string): void {
    if (id === undefined) this.entries.clear();
    else this.entries.delete(id);
  }

  canWarm(): boolean {
    return this.pendingLoads < 2;
  }

  load(
    id: string,
    load: () => Promise<TranscriptionAudioData>,
  ): Promise<TranscriptionAudioData> {
    const existing = this.entries.get(id);
    if (existing) {
      const age =
        existing.loadedAt === null ? 0 : this.now() - existing.loadedAt;
      if (age >= 0 && age < AUDIO_TTL_MS) {
        this.entries.delete(id);
        this.entries.set(id, existing);
        return existing.promise;
      }
      this.entries.delete(id);
    }
    // Invalidating a cache entry does not cancel its native read.
    this.pendingLoads += 1;
    const entry: Entry = {
      promise: Promise.resolve().then(load),
      bytes: 0,
      loadedAt: null,
    };
    entry.promise = entry.promise
      .then((data) => {
        if (this.entries.get(id) !== entry)
          throw new DOMException("Audio load was invalidated", "AbortError");
        if (
          !Number.isFinite(data.sampleRate) ||
          data.sampleRate <= 0 ||
          !data.samples.length ||
          data.samples.some((sample) => !Number.isFinite(sample))
        ) {
          throw new Error("Invalid audio data");
        }
        entry.bytes = data.samples.length * Float64Array.BYTES_PER_ELEMENT;
        entry.loadedAt = this.now();
        if (entry.bytes > this.maxBytes) this.entries.delete(id);
        else this.trim();
        return data;
      })
      .catch((error: unknown) => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        throw error;
      })
      .finally(() => {
        this.pendingLoads -= 1;
      });
    this.entries.set(id, entry);
    return entry.promise;
  }

  private trim(): void {
    const loaded = [...this.entries].filter(
      ([, entry]) => entry.loadedAt !== null,
    );
    let bytes = loaded.reduce((total, [, entry]) => total + entry.bytes, 0);
    let count = loaded.length;
    for (const [id, entry] of loaded) {
      if (bytes <= this.maxBytes && count <= MAX_AUDIO_ENTRIES) break;
      this.entries.delete(id);
      bytes -= entry.bytes;
      count -= 1;
    }
  }
}

export const transcriptionAudioCache = new TranscriptionAudioCache();
