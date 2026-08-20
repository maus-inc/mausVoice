import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { getModelProviderRepo, getTranscribeAudioRepo } from ".";
import {
  AssemblyAITranscribeAudioRepo,
  BaseTranscribeAudioRepo,
  DeepgramTranscribeAudioRepo,
  GladiaTranscribeAudioRepo,
  LocalTranscribeAudioRepo,
  TranscribeAudioOutput,
  TranscribeSegmentInput,
} from "./transcribe-audio.repo";
import { type TranscriptionSegment } from "../utils/hallucination.utils";

/**
 * Mock implementation that tracks calls and returns predictable text
 * based on the segment's position in the audio.
 */
class MockTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  public segmentCalls: TranscribeSegmentInput[] = [];
  public concurrentCalls = 0;
  public maxConcurrentCalls = 0;

  constructor(
    private segmentDuration: number = 10,
    private overlapDuration: number = 2,
    private batchSize: number = 2,
    private transcriptGenerator?: (
      input: TranscribeSegmentInput,
      index: number,
    ) => string,
    private segmentGenerator?: (
      input: TranscribeSegmentInput,
      index: number,
    ) => TranscriptionSegment[] | undefined,
  ) {
    super();
  }

  protected getSegmentDurationSec(): number {
    return this.segmentDuration;
  }

  protected getOverlapDurationSec(): number {
    return this.overlapDuration;
  }

  protected getBatchChunkCount(): number {
    return this.batchSize;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const index = this.segmentCalls.length;
    this.segmentCalls.push(input);

    // Track concurrent calls
    this.concurrentCalls++;
    this.maxConcurrentCalls = Math.max(
      this.maxConcurrentCalls,
      this.concurrentCalls,
    );

    // Simulate async delay
    await new Promise((resolve) => setTimeout(resolve, 10));

    this.concurrentCalls--;

    const text = this.transcriptGenerator
      ? this.transcriptGenerator(input, index)
      : `segment ${index}`;

    const segments = this.segmentGenerator
      ? this.segmentGenerator(input, index)
      : undefined;

    return {
      text,
      segments,
      metadata: {
        inferenceDevice: "Mock Device",
        modelSize: "mock",
        transcriptionMode: "local",
      },
    };
  }
}

// Helper to create samples of a specific duration
const createSamples = (durationSec: number, sampleRate: number): Float32Array =>
  new Float32Array(Math.floor(durationSec * sampleRate));

const resetStore = () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
};

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStore();
});

describe("BaseTranscribeAudioRepo", () => {
  describe("short audio (no splitting)", () => {
    it("should transcribe directly when audio fits in one segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(5, sampleRate); // 5 seconds < 10 second segment

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(1);
      expect(repo.segmentCalls[0]?.samples.length).toBe(samples.length);
      expect(result.text).toBe("segment 0");
    });

    it("should transcribe directly when audio equals segment duration", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(10, sampleRate); // exactly 10 seconds

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(1);
      expect(result.text).toBe("segment 0");
    });
  });

  describe("long audio (with splitting)", () => {
    it("should split audio into overlapping segments", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3);
      const sampleRate = 16000;
      // 25 seconds of audio with 10s segments and 2s overlap (step = 8s)
      // Segments: 0-10s, 8-18s, 16-25s
      const samples = createSamples(25, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(3);

      // Verify segment sizes
      expect(repo.segmentCalls[0]?.samples.length).toBe(sampleRate * 10); // full segment
      expect(repo.segmentCalls[1]?.samples.length).toBe(sampleRate * 10); // full segment
      expect(repo.segmentCalls[2]?.samples.length).toBe(sampleRate * 9); // truncated (16-25s)
    });

    it("should merge transcriptions with overlap detection", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3, (_input, index) => {
        // Simulate overlapping transcriptions
        const transcripts = [
          "The quick brown fox",
          "brown fox jumps over",
          "jumps over the lazy dog",
        ];
        return transcripts[index] ?? "";
      });
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).toBe("The quick brown fox jumps over the lazy dog");
    });

    it("should concatenate when no overlap is detected", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3, (_input, index) => {
        const transcripts = ["Hello world", "Goodbye moon", "See you later"];
        return transcripts[index] ?? "";
      });
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).toBe("Hello world Goodbye moon See you later");
    });

    it("applies probability-gated silence handling to each chunk before merging long audio", async () => {
      // Each chunk returns one real segment plus a near-certain-silence
      // segment (no_speech_prob >= 0.9). The repo must drop the silent segment
      // per-chunk (not just for single-segment audio) before overlap-merging,
      // so long recordings still get the probability gate.
      const chunkTexts = [
        "The cat sat still.",
        "A dog ran home.",
        "Birds flew away.",
      ];
      const repo = new MockTranscribeAudioRepo(
        10,
        2,
        3,
        (_input, index) => chunkTexts[index] ?? "",
        (_input, index) => [
          { text: chunkTexts[index] ?? "", noSpeechProb: 0.1 },
          { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
        ],
      );
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).not.toContain("[BLANK_AUDIO]");
      expect(result.text).toBe(
        "The cat sat still. A dog ran home. Birds flew away.",
      );
    });

    it("preserves each chunk's raw text when hallucination filtering is disabled on long audio", async () => {
      // Mirrors the enabled-path test above but with the off switch on: every
      // chunk still has a near-certain-silence segment, but the repo must merge
      // raw chunk text unchanged so the off switch works for multi-chunk audio.
      const chunkTexts = [
        "The cat sat still.",
        "A dog ran home.",
        "Birds flew away.",
      ];
      const repo = new MockTranscribeAudioRepo(
        10,
        2,
        3,
        (_input, index) => `${chunkTexts[index] ?? ""} [BLANK_AUDIO]`,
        (_input, index) => [
          { text: chunkTexts[index] ?? "", noSpeechProb: 0.1 },
          { text: "[BLANK_AUDIO]", noSpeechProb: 0.99 },
        ],
      );
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({
        samples,
        sampleRate,
        hallucinationFilterEnabled: false,
      });

      expect(result.text).toContain("[BLANK_AUDIO]");
      expect(result.text).toBe(
        "The cat sat still. [BLANK_AUDIO] A dog ran home. [BLANK_AUDIO] Birds flew away. [BLANK_AUDIO]",
      );
    });
  });

  describe("batching behavior", () => {
    it("should respect batch size for concurrent calls", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2); // batch size = 2
      const sampleRate = 16000;
      // 35 seconds with 10s segments and 2s overlap (step = 8s):
      // 0-10s, 8-18s, 16-26s, 24-34s, 32-35s → 5 segments
      const samples = createSamples(35, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(5);
      // Max concurrent should not exceed batch size
      expect(repo.maxConcurrentCalls).toBeLessThanOrEqual(2);
    });

    it("should process single-threaded with batch size 1", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 1); // batch size = 1
      const sampleRate = 16000;
      const samples = createSamples(35, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.maxConcurrentCalls).toBe(1);
    });

    it("should allow higher parallelism with larger batch size", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 4); // batch size = 4
      const sampleRate = 16000;
      // 26 seconds with 10s segments and 2s overlap (step = 8s):
      // 0-10s, 8-18s, 16-26s → 3 segments (all fit in one batch)
      const samples = createSamples(26, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(3);
      // With 3 segments and batch size 4, all should run concurrently
      expect(repo.maxConcurrentCalls).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("should handle empty samples", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);

      const result = await repo.transcribeAudio({
        samples: new Float32Array(0),
        sampleRate: 16000,
      });

      expect(result.text).toBe("");
      expect(repo.segmentCalls).toHaveLength(0);
    });

    it("should handle null/undefined samples", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);

      const result = await repo.transcribeAudio({
        samples: null,
        sampleRate: 16000,
      });

      expect(result.text).toBe("");
      expect(repo.segmentCalls).toHaveLength(0);
    });

    it("should pass prompt and language to each segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate); // 3 segments

      await repo.transcribeAudio({
        samples,
        sampleRate,
        prompt: "technical terms",
        language: "en",
      });

      expect(repo.segmentCalls).toHaveLength(3);
      for (const call of repo.segmentCalls) {
        expect(call.prompt).toBe("technical terms");
        expect(call.language).toBe("en");
      }
    });

    it("should return metadata from first segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.metadata).toEqual({
        inferenceDevice: "Mock Device",
        modelSize: "mock",
        transcriptionMode: "local",
      });
    });
  });

  describe("realistic scenario", () => {
    it("should handle 2-minute audio with realistic settings", async () => {
      // Simulate API-like settings: 60s segments, 5s overlap, batch of 3
      const repo = new MockTranscribeAudioRepo(60, 5, 3, (_input, index) => {
        // Simulate realistic overlapping speech
        const transcripts = [
          "In the beginning there was silence and then came the sound",
          "came the sound of voices speaking softly in the distance",
          "speaking softly in the distance growing louder with each passing moment",
        ];
        return transcripts[index] ?? `segment ${index}`;
      });
      const sampleRate = 16000;
      const samples = createSamples(120, sampleRate); // 2 minutes

      const result = await repo.transcribeAudio({ samples, sampleRate });

      // With 60s segments and 55s step (60-5), we get:
      // 0-60s, 55-115s, 110-120s
      expect(repo.segmentCalls).toHaveLength(3);

      // Verify overlap merging worked
      expect(result.text).toBe(
        "In the beginning there was silence and then came the sound of voices speaking softly in the distance growing louder with each passing moment",
      );
    });
  });
});

describe("DeepgramTranscribeAudioRepo", () => {
  it("requests Deepgram language detection for automatic language", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "bonjour tout le monde" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const repo = new DeepgramTranscribeAudioRepo(
      "dg-key",
      null,
      globalThis.fetch,
    );

    const result = await repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "auto",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));

    expect(result.text).toBe("bonjour tout le monde");
    expect(requestUrl.searchParams.get("detect_language")).toBe("true");
    expect(requestUrl.searchParams.has("language")).toBe(false);
    expect(init?.headers).toMatchObject({
      Authorization: "Token dg-key",
      "Content-Type": "audio/wav",
    });
  });

  it("is selected for Deepgram API transcription preferences", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "deepgram-key";
    state.apiKeyById["deepgram-key"] = {
      id: "deepgram-key",
      name: "Deepgram",
      provider: "deepgram",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "dg-key",
      transcriptionModel: "nova-3",
    };
    setAppState(state, true);

    const { repo, apiKeyId } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(DeepgramTranscribeAudioRepo);
    expect(apiKeyId).toBe("deepgram-key");
  });
});

describe("GladiaTranscribeAudioRepo", () => {
  it("is selected with Gladia's supported model", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "gladia-key";
    state.apiKeyById["gladia-key"] = {
      id: "gladia-key",
      name: "Gladia",
      provider: "gladia",
      createdAt: "2026-08-19T00:00:00.000Z",
      keyFull: "gladia-secret",
      transcriptionModel: "solaria-1",
    };
    setAppState(state, true);

    const { repo, apiKeyId } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(GladiaTranscribeAudioRepo);
    expect(apiKeyId).toBe("gladia-key");
    expect(getModelProviderRepo("gladia").supportsTranscriptionModels()).toBe(
      true,
    );
  });

  it("uses 10-minute chunks, five-second overlap, and concurrency one", () => {
    class InspectableGladiaRepo extends GladiaTranscribeAudioRepo {
      getChunkingConfiguration() {
        return {
          duration: this.getSegmentDurationSec(),
          overlap: this.getOverlapDurationSec(),
          concurrency: this.getBatchChunkCount(),
        };
      }
    }

    const repo = new InspectableGladiaRepo("key", "solaria-1", {
      vocabulary: [],
      spellingDictionary: {},
    });
    expect(repo.getChunkingConfiguration()).toEqual({
      duration: 600,
      overlap: 5,
      concurrency: 1,
    });
  });
});

describe("AssemblyAITranscribeAudioRepo", () => {
  it("is selected for AssemblyAI API transcription preferences", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "assemblyai-key";
    state.apiKeyById["assemblyai-key"] = {
      id: "assemblyai-key",
      name: "AssemblyAI",
      provider: "assemblyai",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "aa-key",
      transcriptionModel: null,
    };
    setAppState(state, true);

    const { repo, apiKeyId } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(AssemblyAITranscribeAudioRepo);
    expect(apiKeyId).toBe("assemblyai-key");
  });

  it("uploads audio, creates a transcript, and polls until completed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/v2/upload")) {
          return new Response(
            JSON.stringify({
              upload_url: "https://cdn.assemblyai.com/upload/abc123",
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v2/transcript") && method === "POST") {
          return new Response(
            JSON.stringify({ id: "transcript-1", status: "queued" }),
            { status: 200 },
          );
        }

        if (url.includes("/v2/transcript/")) {
          return new Response(
            JSON.stringify({
              id: "transcript-1",
              status: "completed",
              text: "hello from assemblyai",
            }),
            { status: 200 },
          );
        }

        return new Response("{}", { status: 404 });
      },
    );

    const repo = new AssemblyAITranscribeAudioRepo("aa-key", globalThis.fetch);
    const result = await repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "auto",
    });

    expect(result.text).toBe("hello from assemblyai");
    expect(result.metadata).toMatchObject({
      inferenceDevice: "API • AssemblyAI",
      transcriptionMode: "api",
    });
  });
});

describe("provider capability and transcription dispatch agreement", () => {
  it("does not advertise Ollama as transcription-capable", () => {
    // The capability flag is false because stock Ollama exposes no speech
    // endpoint. The preferences guard in getTranscriptionPrefs() prevents a
    // stale Ollama selection from ever reaching getTranscribeAudioRepo();
    // should one still reach the dispatch (defense-in-depth), it falls back
    // to Groq only when a configured Groq key is available, otherwise it
    // throws a configuration error — never an unconditional fallback.
    expect(getModelProviderRepo("ollama").supportsTranscriptionModels()).toBe(
      false,
    );
    expect(
      getModelProviderRepo("assemblyai").supportsTranscriptionModels(),
    ).toBe(true);
  });

  it("never routes an unsupported provider (Ollama) to the transcription dispatch", () => {
    // The prefs guard clears the stale Ollama selection before dispatch, so
    // the Groq fallback branch is unreachable from the prefs path.
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "ollama-key";
    state.apiKeyById["ollama-key"] = {
      id: "ollama-key",
      name: "Ollama",
      provider: "ollama",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: null,
      baseUrl: "http://127.0.0.1:11434",
      transcriptionModel: null,
    };
    // Even a configured Groq key must not be reached: unsupported providers
    // are filtered before dispatch.
    state.apiKeyById["groq-key"] = {
      id: "groq-key",
      name: "Groq",
      provider: "groq",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "gq-key",
      transcriptionModel: "whisper-large-v3-turbo",
    };
    setAppState(state, true);

    const { repo, warnings } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(LocalTranscribeAudioRepo);
    expect(warnings.some((warning) => warning.includes("Ollama"))).toBe(false);
    expect(
      warnings.some((warning) =>
        warning.includes("No transcription-capable API key selected"),
      ),
    ).toBe(true);
  });
});
