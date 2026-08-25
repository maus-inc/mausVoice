import { Transcription, TranscriptionAudioSnapshot } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import { orNull, orUndefined } from "../utils/nullable.utils";
import { getAppState } from "../store";
import { getMyEffectiveUserId } from "../utils/user.utils";
import { BaseRepo } from "./base.repo";

const mapAudioSnapshot = (
  audio: TranscriptionAudioSnapshot | null | undefined,
): LocalTranscriptionAudio | undefined =>
  audio
    ? {
        filePath: audio.filePath,
        durationMs: audio.durationMs,
      }
    : undefined;

type LocalTranscriptionAudio = TranscriptionAudioSnapshot;

type LocalTranscription = Omit<
  Transcription,
  "createdAt" | "createdByUserId" | "isDeleted"
> & {
  timestamp: number;
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
  audio: mapAudioSnapshot(transcription.audio),
  modelSize: orNull(transcription.modelSize),
  inferenceDevice: orNull(transcription.inferenceDevice),
  rawTranscript: orNull(transcription.rawTranscript),
  sanitizedTranscript: orNull(transcription.sanitizedTranscript),
  transcriptionPrompt: orNull(transcription.transcriptionPrompt),
  postProcessPrompt: orNull(transcription.postProcessPrompt),
  transcriptionApiKeyId: orNull(transcription.transcriptionApiKeyId),
  postProcessApiKeyId: orNull(transcription.postProcessApiKeyId),
  transcriptionMode: orNull(transcription.transcriptionMode),
  postProcessMode: orNull(transcription.postProcessMode),
  postProcessDevice: orNull(transcription.postProcessDevice),
  postProcessProvider: orNull(transcription.postProcessProvider),
  postProcessFailed: transcription.postProcessFailed ?? null,
  postProcessError: orNull(transcription.postProcessError),
  transcriptionDurationMs: orNull(transcription.transcriptionDurationMs),
  postprocessDurationMs: orNull(transcription.postprocessDurationMs),
  warnings: orNull(transcription.warnings),
  remoteStatus: orNull(transcription.remoteStatus),
  remoteDeviceId: orNull(transcription.remoteDeviceId),
});

const fromLocalTranscription = (
  transcription: LocalTranscription,
): Transcription => ({
  id: transcription.id,
  transcript: transcription.transcript,
  createdAt: dayjs(transcription.timestamp).toISOString(),
  createdByUserId: getMyEffectiveUserId(getAppState()),
  isDeleted: false,
  audio: mapAudioSnapshot(transcription.audio),
  modelSize: orUndefined(transcription.modelSize),
  inferenceDevice: orUndefined(transcription.inferenceDevice),
  rawTranscript: orUndefined(transcription.rawTranscript),
  sanitizedTranscript: orUndefined(transcription.sanitizedTranscript),
  transcriptionPrompt: orUndefined(transcription.transcriptionPrompt),
  postProcessPrompt: orUndefined(transcription.postProcessPrompt),
  transcriptionApiKeyId: orUndefined(transcription.transcriptionApiKeyId),
  postProcessApiKeyId: orUndefined(transcription.postProcessApiKeyId),
  transcriptionMode: orUndefined(transcription.transcriptionMode),
  postProcessMode: orUndefined(transcription.postProcessMode),
  postProcessDevice: orUndefined(transcription.postProcessDevice),
  postProcessProvider: orUndefined(transcription.postProcessProvider),
  postProcessFailed: transcription.postProcessFailed ?? undefined,
  postProcessError: orUndefined(transcription.postProcessError),
  transcriptionDurationMs: orUndefined(transcription.transcriptionDurationMs),
  postprocessDurationMs: orUndefined(transcription.postprocessDurationMs),
  warnings: orUndefined(transcription.warnings),
  remoteStatus:
    (transcription.remoteStatus as "sent" | "received") ?? undefined,
  remoteDeviceId: orUndefined(transcription.remoteDeviceId),
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
  abstract importAudioFile(): Promise<ImportedTranscriptionAudioData | null>;
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

  async importAudioFile(): Promise<ImportedTranscriptionAudioData | null> {
    // The native command owns the OS picker. Accepting a renderer-provided path
    // here would turn IPC into a reusable reader for every file under the
    // allowed roots instead of a one-shot, user-authorized selection.
    const payload = await invoke<NativeImportedAudioData | null>(
      "transcription_import_audio",
    );
    if (!payload) return null;
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
