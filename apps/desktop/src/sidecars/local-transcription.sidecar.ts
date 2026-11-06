import { readAbortableResponseJson } from "@maus-inc/utilities";
import {
  parsePrivateProviderJson,
  readBoundedProviderErrorBody,
  sanitizeProviderError,
} from "@maus-inc/voice-ai";
import { appDataDir, join, resolveResource } from "@tauri-apps/api/path";
import {
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModel,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import type { ShellChildProcess } from "../utils/tauri-shell.utils";
import { BaseSidecar, type SidecarRuntime } from "./base.sidecar";
import { fetchWithTimeout, sleep, toErrorMessage } from "./sidecar.utils";

type SidecarHealthResponse = {
  status: string;
  mode: string;
};

export type LocalSidecarModelStatus = {
  model: LocalWhisperModel;
  downloaded: boolean;
  valid: boolean;
  fileBytes: number | null;
  validationError: string | null;
};

export type LocalSidecarDownloadSnapshot = {
  jobId: string;
  model: LocalWhisperModel;
  status:
    "pending" | "running" | "paused" | "completed" | "failed" | "canceled";
  bytesDownloaded: number;
  totalBytes: number | null;
  progress: number | null;
  error: string | null;
};

type SidecarTranscriptionResponse = {
  text: string;
  model: LocalWhisperModel;
  inferenceDevice: string;
  durationMs: number;
  segments: LocalSidecarTranscribeOutput["segments"];
};

type SidecarCreateTranscriptionSessionResponse = {
  sessionId: string;
};

type SidecarAppendTranscriptionChunkResponse = {
  receivedSamples: number;
  bufferedSamples: number;
};

type SidecarDeleteTranscriptionSessionResponse = {
  deleted: boolean;
};

export type LocalSidecarDevice = {
  id: string;
  name: string;
  mode: "cpu" | "gpu";
};

type SidecarDevicesResponse = {
  devices: Array<Omit<LocalSidecarDevice, "mode">>;
};

export type LocalSidecarTranscribeInput = {
  model: LocalWhisperModel;
  samples: number[] | Float32Array;
  sampleRate: number;
  language?: string;
  initialPrompt?: string;
  preferGpu: boolean;
  deviceId?: string;
  hallucinationFilterEnabled?: boolean;
  /** Aborts the finalize request and releases the sidecar session. */
  signal?: AbortSignal;
};

export type LocalSidecarStreamingSessionInput = Omit<
  LocalSidecarTranscribeInput,
  "samples" | "signal"
>;

export type LocalSidecarTranscribeOutput = {
  text: string;
  model: LocalWhisperModel;
  inferenceDevice: string;
  durationMs: number;
  mode: LocalSidecarDevice["mode"];
  segments: Array<{ text: string; noSpeechProb: number }>;
};

export type LocalSidecarStreamingSession = {
  writeAudioChunk: (samples: number[] | Float32Array) => void;
  finalize: (signal?: AbortSignal) => Promise<LocalSidecarTranscribeOutput>;
  cleanup: () => void;
};

const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_BOUND_PORT_PREFIX = "RUST_TRANSCRIPTION_BOUND_PORT=";
const SIDECAR_REQUEST_TIMEOUT_MS = 120_000;
const SIDECAR_REQUEST_RETRIES = 2;
const SIDECAR_REQUEST_RETRY_DELAY_MS = 250;
/** Shared defaults for runtime-bound and explicit-URL sidecar requests. */
const requestLimits = (options?: { timeoutMs?: number; retries?: number }) => ({
  retries: options?.retries ?? SIDECAR_REQUEST_RETRIES,
  timeoutMs: options?.timeoutMs ?? SIDECAR_REQUEST_TIMEOUT_MS,
});

const MODEL_DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1_000;
const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 500;
const SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT = 16_000;
const SIDECAR_IDLE_DISPOSE_MS = 60_000;

export class SidecarRequestError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SidecarRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Keep only the code needed for the missing-model retry, never response text. */
const privateTranscriptionError = (
  status: number,
  text: string,
): SidecarRequestError => {
  let code: string | undefined;
  try {
    const payload = JSON.parse(text) as { error?: { code?: unknown } } | null;
    const rawCode = payload?.error?.code;
    if (rawCode === "model_not_downloaded") code = rawCode;
    else if (rawCode) code = "other_sidecar_error";
    else code = undefined;
  } catch {
    // Invalid private error bodies supply neither trusted text nor a code.
  }
  return new SidecarRequestError(
    `Sidecar request failed (${status})`,
    status,
    code,
  );
};

/** Preserve useful model-management details without exposing credentials. */
const diagnosticSidecarError = (
  status: number,
  text: string,
): SidecarRequestError => {
  const fallbackMessage = `Sidecar request failed (${status})`;
  try {
    const payload = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const rawCode = payload?.error?.code;
    const rawMessage = payload?.error?.message;
    const code =
      typeof rawCode === "string"
        ? (sanitizeProviderError(rawCode) ?? undefined)
        : undefined;
    const message =
      typeof rawMessage === "string" ? sanitizeProviderError(rawMessage) : null;
    return new SidecarRequestError(message || fallbackMessage, status, code);
  } catch {
    const detail = sanitizeProviderError(text.trim());
    return new SidecarRequestError(
      detail || fallbackMessage,
      status,
      undefined,
    );
  }
};

export class LocalTranscriptionSidecar extends BaseSidecar {
  readonly mode: LocalSidecarDevice["mode"];
  private readyModels = new Map<string, Promise<void>>();
  private modelsDirPromise: Promise<string> | null = null;

  constructor(mode: LocalSidecarDevice["mode"]) {
    const binaryName =
      mode === "gpu"
        ? "binaries/rust-transcription-gpu"
        : "binaries/rust-transcription-cpu";

    super({
      binaryName,
      host: SIDECAR_HOST,
      startupTimeoutMs: 15_000,
      healthTimeoutMs: 2_000,
      healthPollIntervalMs: 150,
      logPrefix: `local-sidecar:${mode}`,
      idleDisposeMs: SIDECAR_IDLE_DISPOSE_MS,
    });

    this.mode = mode;
  }

  // --- BaseSidecar abstract implementations ---

  protected async buildSpawnEnv(): Promise<Record<string, string>> {
    const modelsDir = await this.resolveModelsDir();
    return {
      RUST_TRANSCRIPTION_HOST: SIDECAR_HOST,
      RUST_TRANSCRIPTION_PORT: "0",
      RUST_TRANSCRIPTION_MODELS_DIR: modelsDir,
    };
  }

  protected async buildSpawnCwd(): Promise<string | undefined> {
    // On Windows the sherpa-onnx shared DLLs are bundled under
    // `binaries/onnxruntime/`. Windows searches the child's working directory
    // for import-table DLLs, so launching the sidecar with that folder as cwd
    // lets it locate onnxruntime.dll / sherpa-onnx-c-api.dll without modifying
    // the system PATH. On other platforms this folder is also bundled and the
    // change is harmless (the sidecar resolves its own runtime via rpath and
    // uses absolute paths for model data).
    try {
      return await resolveResource("binaries/onnxruntime");
    } catch (error) {
      getLogger().warning(
        `[${this.config.logPrefix}] could not resolve sherpa runtime dir: ${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  protected parsePortFromLine(line: string): number | null {
    if (!line.startsWith(SIDECAR_BOUND_PORT_PREFIX)) {
      return null;
    }

    const portValue = line.slice(SIDECAR_BOUND_PORT_PREFIX.length).trim();
    // parseInt accepts partial values such as "8080garbage". Never probe a
    // different local service after a malformed readiness announcement.
    if (!/^\d+$/.test(portValue)) return null;
    const port = Number(portValue);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return null;
    }

    return port;
  }

  protected handleStdoutLine(line: string, _child: ShellChildProcess): void {
    getLogger().verbose(`[${this.config.logPrefix}] stdout: ${line}`);
  }

  protected onStarted(_runtime: SidecarRuntime): void {}

  protected onStopped(): void {}

  protected onError(_message: string): void {}

  protected async checkHealthResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<boolean> {
    const payload = await readAbortableResponseJson<SidecarHealthResponse>(
      response,
      signal,
    );
    return payload.status === "ok" && payload.mode === this.mode;
  }

  // --- Public API ---

  async getModelStatus(
    model: LocalWhisperModel,
    validate = true,
  ): Promise<LocalSidecarModelStatus> {
    return await this.requestJson<LocalSidecarModelStatus>(
      `/v1/models/${model}/status?validate=${validate ? "true" : "false"}`,
    );
  }

  async listModelStatuses(
    models: LocalWhisperModel[] = LOCAL_WHISPER_MODELS,
    validate = true,
  ): Promise<Record<LocalWhisperModel, LocalSidecarModelStatus>> {
    const statuses = await Promise.all(
      models.map(async (model) => {
        const status = await this.getModelStatus(model, validate);
        return [model, status] as const;
      }),
    );

    const map = {} as Record<LocalWhisperModel, LocalSidecarModelStatus>;
    for (const [model, status] of statuses) {
      map[model] = status;
    }

    return map;
  }

  async listDevices(): Promise<LocalSidecarDevice[]> {
    const response = await this.requestJson<SidecarDevicesResponse>(
      "/v1/devices",
      undefined,
      { retries: 1 },
    );

    return response.devices.map((device) => ({
      ...device,
      mode: this.mode,
    }));
  }

  async downloadModel(
    model: LocalWhisperModel,
    onProgress?: (snapshot: LocalSidecarDownloadSnapshot) => void,
  ): Promise<LocalSidecarModelStatus | null> {
    const result = await this.downloadModelInternal(model, onProgress);
    if (result.status === "paused" || result.status === "canceled") {
      return null;
    }

    const finalStatus = await this.validateDownloadedModel(model);
    return finalStatus;
  }

  async pauseDownload(
    model: LocalWhisperModel,
  ): Promise<LocalSidecarDownloadSnapshot> {
    return await this.requestJson<LocalSidecarDownloadSnapshot>(
      `/v1/models/${model}/download/pause`,
      { method: "POST" },
    );
  }

  async cancelDownload(
    model: LocalWhisperModel,
  ): Promise<LocalSidecarDownloadSnapshot> {
    const result = await this.requestJson<LocalSidecarDownloadSnapshot>(
      `/v1/models/${model}/download/cancel`,
      { method: "POST" },
    );
    this.invalidateModelReadiness(model);
    return result;
  }

  async deleteModel(
    model: LocalWhisperModel,
  ): Promise<LocalSidecarModelStatus> {
    const status = await this.requestJson<LocalSidecarModelStatus>(
      `/v1/models/${model}`,
      { method: "DELETE" },
    );

    this.invalidateModelReadiness(model);
    return status;
  }

  async transcribe(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    try {
      return await this.transcribeInternal(input);
    } catch (error) {
      if (!this.isModelMissingError(error)) {
        throw error;
      }

      this.invalidateModelReadiness(input.model);
      const download = await this.downloadModelInternal(input.model);
      this.assertDownloadCompleted(input.model, download);
      return await this.transcribeInternal(input);
    }
  }

  async createStreamingSession(
    input: LocalSidecarStreamingSessionInput,
    /** Stops pending chunk uploads; finalize takes its own signal. */
    signal?: AbortSignal,
  ): Promise<LocalSidecarStreamingSession> {
    await this.ensureModelReady(input.model);

    const created =
      await this.requestJson<SidecarCreateTranscriptionSessionResponse>(
        "/v1/transcriptions/sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.toSessionConfigPayload(input)),
        },
      );
    this.markModelReady(input.model);

    const sessionPath = `/v1/transcriptions/sessions/${created.sessionId}`;
    const sidecarPid = this.getRuntime()?.child.pid ?? null;
    getLogger().info(
      `[${this.config.logPrefix}] created streaming session ${created.sessionId} (pid=${sidecarPid})`,
    );
    let queue = Promise.resolve();
    let queuedError: unknown = null;
    let released = false;
    let finalizePromise: Promise<LocalSidecarTranscribeOutput> | null = null;

    // Pin the sidecar process for the lifetime of this session: the 60s
    // idle-dispose must never kill the process under an open session (a long
    // speech pause used to do exactly that, producing 404 session_not_found
    // on the next chunk/finalize).
    const releaseActivityLease = this.beginActivityLease();

    const releaseSession = async (): Promise<void> => {
      if (released) {
        return;
      }

      released = true;
      releaseActivityLease();
      await this.requestJson<SidecarDeleteTranscriptionSessionResponse>(
        sessionPath,
        { method: "DELETE" },
        { retries: 1 },
      );
    };

    const queueChunkUpload = (samples: Float32Array): void => {
      if (released || queuedError || signal?.aborted || samples.length === 0) {
        return;
      }

      const body = new ArrayBuffer(samples.byteLength);
      new Uint8Array(body).set(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      );

      queue = queue
        .then(async () => {
          if (released || queuedError) {
            return;
          }
          signal?.throwIfAborted();

          await this.requestJson<SidecarAppendTranscriptionChunkResponse>(
            `${sessionPath}/chunks`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body,
              signal,
            },
            { retries: 1 },
          );
        })
        .catch((error) => {
          queuedError = error;
          if (signal?.aborted) return;
          getLogger().warning(
            `[${this.config.logPrefix}] failed to stream audio chunk (${toErrorMessage(error)})`,
          );
        });
    };

    return {
      writeAudioChunk: (samples) => {
        if (released || finalizePromise) {
          return;
        }
        queueChunkUpload(this.toFloat32Array(samples));
      },
      finalize: async (signal) => {
        if (finalizePromise) {
          return await finalizePromise;
        }

        finalizePromise = (async () => {
          await queue;
          if (queuedError) {
            getLogger().warning(
              `[${this.config.logPrefix}] finalize aborting due to queued chunk error: ${toErrorMessage(queuedError)}`,
            );
            throw queuedError;
          }

          getLogger().info(
            `[${this.config.logPrefix}] sending finalize request for session ${created.sessionId}`,
          );
          const result = await this.requestJson<SidecarTranscriptionResponse>(
            `${sessionPath}/finalize`,
            { method: "POST", signal },
          );
          getLogger().info(
            `[${this.config.logPrefix}] finalize response received (${result.text.length} chars)`,
          );
          this.markModelReady(input.model);

          return {
            text: result.text,
            model: result.model,
            inferenceDevice: result.inferenceDevice,
            durationMs: result.durationMs,
            mode: this.mode,
            segments: result.segments ?? [],
          };
        })();

        try {
          return await finalizePromise;
        } finally {
          await releaseSession().catch((error) => {
            getLogger().verbose(
              `[${this.config.logPrefix}] failed to release transcription session (${toErrorMessage(error)})`,
            );
          });
        }
      },
      cleanup: () => {
        void releaseSession().catch((error) => {
          getLogger().verbose(
            `[${this.config.logPrefix}] failed to clean up transcription session (${toErrorMessage(error)})`,
          );
        });
      },
    };
  }

  invalidateModelReadiness(model: LocalWhisperModel): void {
    this.readyModels.delete(model);
  }

  // --- Private helpers ---

  private async transcribeInternal(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    input.signal?.throwIfAborted();
    const session = await this.createStreamingSession(input, input.signal);
    const floatSamples = this.toFloat32Array(input.samples);

    try {
      for (
        let cursor = 0;
        cursor < floatSamples.length;
        cursor += SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT
      ) {
        const end = Math.min(
          cursor + SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT,
          floatSamples.length,
        );
        session.writeAudioChunk(floatSamples.subarray(cursor, end));
      }

      return await session.finalize(input.signal);
    } catch (error) {
      session.cleanup();
      throw error;
    }
  }

  private toSessionConfigPayload(input: LocalSidecarStreamingSessionInput): {
    model: LocalWhisperModel;
    sampleRate: number;
    language?: string;
    initialPrompt?: string;
    deviceId?: string;
    hallucinationFilterEnabled: boolean;
  } {
    const normalizedDeviceId = input.deviceId?.trim().toLowerCase();
    const deviceId =
      this.mode === "gpu"
        ? normalizedDeviceId?.startsWith("gpu:")
          ? normalizedDeviceId
          : undefined
        : normalizedDeviceId?.startsWith("cpu:")
          ? normalizedDeviceId
          : undefined;

    return {
      model: input.model,
      sampleRate: input.sampleRate,
      language: input.language === "auto" ? undefined : input.language,
      initialPrompt: input.initialPrompt,
      deviceId,
      hallucinationFilterEnabled: input.hallucinationFilterEnabled !== false,
    };
  }

  private toFloat32Array(samples: number[] | Float32Array): Float32Array {
    if (samples instanceof Float32Array) {
      return samples;
    }

    return Float32Array.from(samples);
  }

  private async ensureModelReady(model: LocalWhisperModel): Promise<void> {
    const existing = this.readyModels.get(model);
    if (existing) {
      return await existing;
    }

    const pending = this.ensureModelReadyInternal(model)
      .then(() => undefined)
      .catch((error) => {
        this.readyModels.delete(model);
        throw error;
      });

    this.readyModels.set(model, pending);
    await pending;
  }

  private async ensureModelReadyInternal(
    model: LocalWhisperModel,
  ): Promise<void> {
    const currentStatus = await this.getModelStatus(model, true);

    if (currentStatus.downloaded && currentStatus.valid) {
      this.markModelReady(model);
      return;
    }

    const download = await this.downloadModelInternal(model);
    this.assertDownloadCompleted(model, download);

    await this.validateDownloadedModel(model);
  }

  private async validateDownloadedModel(
    model: LocalWhisperModel,
  ): Promise<LocalSidecarModelStatus> {
    const status = await this.getModelStatus(model, true);
    if (!status.downloaded || !status.valid) {
      throw new Error(
        status.validationError ||
          `Model '${model}' failed validation (${this.mode.toUpperCase()})`,
      );
    }
    this.markModelReady(model);
    return status;
  }

  private markModelReady(model: LocalWhisperModel): void {
    this.readyModels.set(model, Promise.resolve());
  }

  private assertDownloadCompleted(
    model: LocalWhisperModel,
    snapshot: LocalSidecarDownloadSnapshot,
  ): void {
    if (snapshot.status === "paused") {
      throw new Error(
        `Model download is paused for '${model}' (${this.mode.toUpperCase()})`,
      );
    }
    if (snapshot.status === "canceled") {
      throw new Error(
        `Model download was canceled for '${model}' (${this.mode.toUpperCase()})`,
      );
    }
    if (snapshot.status !== "completed") {
      throw new Error(
        snapshot.error ||
          `Model download did not complete for '${model}' (${this.mode.toUpperCase()})`,
      );
    }
  }

  /** Classify snapshots consistently whether returned by the start or poll endpoint. */
  private isDownloadFinished(
    model: LocalWhisperModel,
    snapshot: LocalSidecarDownloadSnapshot,
  ): boolean {
    if (snapshot.status === "failed") {
      throw new Error(
        snapshot.error ||
          `Model download failed for '${model}' (${this.mode.toUpperCase()})`,
      );
    }
    return (
      snapshot.status === "completed" ||
      snapshot.status === "paused" ||
      snapshot.status === "canceled"
    );
  }

  private async downloadModelInternal(
    model: LocalWhisperModel,
    onProgress?: (snapshot: LocalSidecarDownloadSnapshot) => void,
  ): Promise<LocalSidecarDownloadSnapshot> {
    const job = await this.requestJson<LocalSidecarDownloadSnapshot>(
      `/v1/models/${model}/download`,
      { method: "POST" },
    );

    onProgress?.(job);

    if (this.isDownloadFinished(model, job)) return job;

    const deadline = Date.now() + MODEL_DOWNLOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const progress = await this.requestJson<LocalSidecarDownloadSnapshot>(
        `/v1/models/${model}/download/${job.jobId}`,
        undefined,
        { retries: 1 },
      );

      onProgress?.(progress);

      if (this.isDownloadFinished(model, progress)) return progress;

      await sleep(MODEL_DOWNLOAD_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Model download timed out for '${model}' (${this.mode.toUpperCase()})`,
    );
  }

  private isModelMissingError(error: unknown): boolean {
    if (!(error instanceof SidecarRequestError)) {
      return false;
    }

    if (error.status !== 404) {
      return false;
    }

    return !error.code || error.code === "model_not_downloaded";
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
    options?: {
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<T> {
    const { retries, timeoutMs } = requestLimits(options);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const runtime = await this.ensureStarted();
      try {
        const result = await this.requestJsonByUrl<T>(runtime.baseUrl, path, {
          init,
          timeoutMs,
          retries: 1,
        });
        this.markActivity();
        return result;
      } catch (error) {
        lastError = error;
        const isTransport = this.isTransportError(error);
        const isRetriable = this.isRetriableError(error);

        getLogger().warning(
          `[${this.config.logPrefix}] request failed for ${path} (attempt ${attempt}/${retries}, transport=${isTransport}, retriable=${isRetriable}): ${String(error)}`,
        );

        if (isTransport) {
          getLogger().warning(
            `[${this.config.logPrefix}] disposing runtime due to transport error`,
          );
          await this.resetRuntime();
        }

        if (attempt < retries && isRetriable) {
          await sleep(SIDECAR_REQUEST_RETRY_DELAY_MS * attempt);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Request failed for ${this.mode} sidecar at ${path}`);
  }

  private async requestJsonByUrl<T>(
    baseUrl: string,
    path: string,
    options?: {
      init?: RequestInit;
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<T> {
    const { retries, timeoutMs } = requestLimits(options);
    const init = options?.init;
    if (retries < 1) throw new Error(`Request failed for ${path}`);

    // Each retry waits out its own backoff before the next request, so the
    // attempts cannot overlap; one recursive call states one attempt.
    const attempt = async (number: number): Promise<T> => {
      try {
        return await this.fetchJson<T>(`${baseUrl}${path}`, init, timeoutMs);
      } catch (error) {
        if (number >= retries || !this.isRetriableError(error)) throw error;
        await sleep(SIDECAR_REQUEST_RETRY_DELAY_MS * number);
        return attempt(number + 1);
      }
    };

    return attempt(1);
  }

  /** Decode one response; retry decisions remain with the request loop. */
  private async fetchJson<T>(
    url: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    const signal = init?.signal ?? undefined;
    if (!response.ok) {
      const privateResponse = new URL(url).pathname.startsWith(
        "/v1/transcriptions",
      );
      const error = await this.buildHttpError(response, privateResponse);
      signal?.throwIfAborted();
      throw error;
    }
    return await parsePrivateProviderJson<T>(response, "Sidecar", signal);
  }

  private async buildHttpError(
    response: Response,
    privateResponse = false,
  ): Promise<SidecarRequestError> {
    // Read once, with size and time limits; parsing failures may contain
    // arbitrary private fragments, so never put parser errors in diagnostics.
    const text = (await readBoundedProviderErrorBody(response)) ?? "";
    return privateResponse
      ? privateTranscriptionError(response.status, text)
      : diagnosticSidecarError(response.status, text);
  }

  private isRetriableError(error: unknown): boolean {
    if (!(error instanceof SidecarRequestError)) {
      return false;
    }

    if (error.status === undefined) {
      return true;
    }

    return error.status >= 500;
  }

  private isTransportError(error: unknown): boolean {
    return error instanceof SidecarRequestError && error.status === undefined;
  }

  private async resolveModelsDir(): Promise<string> {
    if (!this.modelsDirPromise) {
      this.modelsDirPromise = appDataDir().then(
        async (baseDir) => await join(baseDir, "transcription-models"),
      );
    }
    return await this.modelsDirPromise;
  }
}
