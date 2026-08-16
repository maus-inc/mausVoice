import {
  PostProcessingMode,
  Transcription,
  TranscriptionAudioSnapshot,
  TranscriptionMode,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import { getAppState } from "../store";
import { getMyEffectiveUserId } from "../utils/user.utils";
import { BaseRepo } from "./base.repo";

type LocalTranscriptionAudio = TranscriptionAudioSnapshot;

type LocalTranscription = {
  id: string;
  transcript: string;
  timestamp: number;
  audio?: LocalTranscriptionAudio | null;
  modelSize?: string | null;
  inferenceDevice?: string | null;
  rawTranscript?: string | null;
  sanitizedTranscript?: string | null;
  transcriptionPrompt?: string | null;
  postProcessPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  postProcessApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  postProcessMode?: PostProcessingMode | null;
  postProcessDevice?: string | null;
  transcriptionDurationMs?: number | null;
  postprocessDurationMs?: number | null;
  warnings?: string[] | null;
  remoteStatus?: string | null;
  remoteDeviceId?: string | null;
};

export type TranscriptionAudioData = {
  samples: number[];
  sampleRate: number;
};

type NativeImportedAudioData = {
  pcm16Le: number[] | Uint8Array | ArrayBuffer;
  sampleRate: number;
};

export type ImportedTranscriptionAudioData = {
  samples: Float32Array;
  sampleRate: number;
};

const decodePcm16Le = (
  payload: number[] | Uint8Array | ArrayBuffer,
): Float32Array => {
  let bytes: Uint8Array;
  if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (payload instanceof Uint8Array) {
    bytes = payload;
  } else {
    bytes = Uint8Array.from(payload);
  }
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("Imported audio returned an invalid PCM payload.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
};

export type ListTranscriptionsParams = {
  limit?: number;
  offset?: number;
};

const toLocalTranscription = (
  transcription: Transcription,
): LocalTranscription => ({
  id: transcription.id,
  transcript: transcription.transcript,
  timestamp: dayjs(transcription.createdAt).valueOf(),
  audio: transcription.audio
    ? {
        filePath: transcription.audio.filePath,
        durationMs: transcription.audio.durationMs,
      }
    : undefined,
  modelSize: transcription.modelSize ?? null,
  inferenceDevice: transcription.inferenceDevice ?? null,
  rawTranscript: transcription.rawTranscript ?? null,
  sanitizedTranscript: transcription.sanitizedTranscript ?? null,
  transcriptionPrompt: transcription.transcriptionPrompt ?? null,
  postProcessPrompt: transcription.postProcessPrompt ?? null,
  transcriptionApiKeyId: transcription.transcriptionApiKeyId ?? null,
  postProcessApiKeyId: transcription.postProcessApiKeyId ?? null,
  transcriptionMode: transcription.transcriptionMode ?? null,
  postProcessMode: transcription.postProcessMode ?? null,
  postProcessDevice: transcription.postProcessDevice ?? null,
  transcriptionDurationMs: transcription.transcriptionDurationMs ?? null,
  postprocessDurationMs: transcription.postprocessDurationMs ?? null,
  warnings: transcription.warnings ?? null,
  remoteStatus: transcription.remoteStatus ?? null,
  remoteDeviceId: transcription.remoteDeviceId ?? null,
});

const fromLocalTranscription = (
  transcription: LocalTranscription,
): Transcription => ({
  id: transcription.id,
  transcript: transcription.transcript,
  createdAt: dayjs(transcription.timestamp).toISOString(),
  createdByUserId: getMyEffectiveUserId(getAppState()),
  isDeleted: false,
  audio: transcription.audio
    ? {
        filePath: transcription.audio.filePath,
        durationMs: transcription.audio.durationMs,
      }
    : undefined,
  modelSize: transcription.modelSize ?? undefined,
  inferenceDevice: transcription.inferenceDevice ?? undefined,
  rawTranscript: transcription.rawTranscript ?? undefined,
  sanitizedTranscript: transcription.sanitizedTranscript ?? undefined,
  transcriptionPrompt: transcription.transcriptionPrompt ?? undefined,
  postProcessPrompt: transcription.postProcessPrompt ?? undefined,
  transcriptionApiKeyId: transcription.transcriptionApiKeyId ?? undefined,
  postProcessApiKeyId: transcription.postProcessApiKeyId ?? undefined,
  transcriptionMode: transcription.transcriptionMode ?? undefined,
  postProcessMode: transcription.postProcessMode ?? undefined,
  postProcessDevice: transcription.postProcessDevice ?? undefined,
  transcriptionDurationMs: transcription.transcriptionDurationMs ?? undefined,
  postprocessDurationMs: transcription.postprocessDurationMs ?? undefined,
  warnings: transcription.warnings ?? undefined,
  remoteStatus:
    (transcription.remoteStatus as "sent" | "received") ?? undefined,
  remoteDeviceId: transcription.remoteDeviceId ?? undefined,
});

export abstract class BaseTranscriptionRepo extends BaseRepo {
  abstract createTranscription(
    transcription: Transcription,
  ): Promise<Transcription>;
  abstract listTranscriptions(
    params?: ListTranscriptionsParams,
  ): Promise<Transcription[]>;
  abstract deleteTranscription(id: string): Promise<void>;
  abstract updateTranscription(
    transcription: Transcription,
  ): Promise<Transcription>;
  abstract loadTranscriptionAudio(id: string): Promise<TranscriptionAudioData>;
  abstract importAudioFile(
    path: string,
  ): Promise<ImportedTranscriptionAudioData>;
  abstract purgeStaleAudio(): Promise<string[]>;
}

export class LocalTranscriptionRepo extends BaseTranscriptionRepo {
  async createTranscription(
    transcription: Transcription,
  ): Promise<Transcription> {
    const stored = await invoke<LocalTranscription>("transcription_create", {
      transcription: toLocalTranscription(transcription),
    });

    return fromLocalTranscription(stored);
  }

  async listTranscriptions(
    params: ListTranscriptionsParams = {},
  ): Promise<Transcription[]> {
    const limit = Math.max(0, Math.trunc(params.limit ?? 20));
    const offset = Math.max(0, Math.trunc(params.offset ?? 0));

    const transcriptions = await invoke<LocalTranscription[]>(
      "transcription_list",
      { limit, offset },
    );

    return transcriptions.map(fromLocalTranscription);
  }

  async deleteTranscription(id: string): Promise<void> {
    await invoke<void>("transcription_delete", { id });
  }

  async updateTranscription(
    transcription: Transcription,
  ): Promise<Transcription> {
    const stored = await invoke<LocalTranscription>("transcription_update", {
      transcription: toLocalTranscription(transcription),
    });
    return fromLocalTranscription(stored);
  }

  async loadTranscriptionAudio(id: string): Promise<TranscriptionAudioData> {
    return invoke<TranscriptionAudioData>("transcription_audio_load", { id });
  }

  async importAudioFile(path: string): Promise<ImportedTranscriptionAudioData> {
    const payload = await invoke<NativeImportedAudioData>(
      "transcription_import_audio",
      { path },
    );
    return {
      samples: decodePcm16Le(payload.pcm16Le),
      sampleRate: payload.sampleRate,
    };
  }

  async purgeStaleAudio(): Promise<string[]> {
    const purged = await invoke<string[] | undefined>(
      "purge_stale_transcription_audio",
    );
    return Array.isArray(purged) ? purged : [];
  }
}
