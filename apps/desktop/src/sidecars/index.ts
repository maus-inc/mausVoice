import { invoke } from "@tauri-apps/api/core";
import {
  supportsGpuTranscriptionDevice,
  type LocalWhisperModel,
  LOCAL_WHISPER_MODELS,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { type GpuInfo } from "../types/gpu.types";
import {
  LocalTranscriptionSidecar,
  SidecarRequestError,
  type LocalSidecarDevice,
  type SidecarDownloadSnapshot,
  type SidecarModelStatusResponse,
  type LocalSidecarStreamingSession,
  type LocalSidecarStreamingSessionInput,
  type LocalSidecarTranscribeInput,
  type LocalSidecarTranscribeOutput,
} from "./local-transcription.sidecar";
import { toErrorMessage } from "./sidecar.utils";

export { isSessionNotFoundError } from "./local-transcription.sidecar";

export type {
  LocalSidecarDevice,
  SidecarDownloadSnapshot,
  SidecarModelStatusResponse,
  LocalSidecarStreamingSession,
  LocalSidecarStreamingSessionInput,
  LocalSidecarTranscribeInput,
  LocalSidecarTranscribeOutput,
} from "./local-transcription.sidecar";

export class LocalTranscriptionSidecarFacade {
  private readonly cpuSidecar = new LocalTranscriptionSidecar("cpu");
  private readonly gpuSidecar = new LocalTranscriptionSidecar("gpu");
  private gpuUnavailable = false;
  private gpuDetection: Promise<boolean> | null = null;
  private readonly downloadOwners = new Map<
    LocalWhisperModel,
    LocalTranscriptionSidecar
  >();

  /**
   * Detects whether the machine actually has a GPU the transcription sidecar
   * can use. Cached: spawning the GPU binary on machines with no GPU (the
   * user's logs showed an empty GPU enumeration) wasted ~20s per boot on a
   * doomed health check before falling back to CPU.
   */
  private async detectGpu(): Promise<boolean> {
    this.gpuDetection ??= (async () => {
      try {
        const gpus = await invoke<GpuInfo[]>("list_gpus");
        return gpus.some(
          (info) =>
            info.backend === "Vulkan" && info.deviceType === "DiscreteGpu",
        );
      } catch (error) {
        getLogger().verbose(
          `[local-sidecar] GPU detection failed (${toErrorMessage(error)}), assuming CPU-only`,
        );
        return false;
      }
    })();
    return await this.gpuDetection;
  }

  private async gpuIsUsable(): Promise<boolean> {
    return (
      supportsGpuTranscriptionDevice() &&
      !this.gpuUnavailable &&
      (await this.detectGpu())
    );
  }

  async listAvailableDevices(): Promise<LocalSidecarDevice[]> {
    await this.cpuSidecar.ensureStarted();
    const cpuDevices = await this.cpuSidecar.listDevices();
    const devices = [...cpuDevices];

    if (await this.gpuIsUsable()) {
      try {
        await this.gpuSidecar.ensureStarted();
        const gpuDevices = await this.gpuSidecar.listDevices();
        devices.push(...gpuDevices);
      } catch (error) {
        this.markGpuUnavailable(error);
      }
    }

    return devices;
  }

  async listModelStatuses({
    preferGpu,
    validate = true,
    models = LOCAL_WHISPER_MODELS,
  }: {
    preferGpu: boolean;
    validate?: boolean;
    models?: LocalWhisperModel[];
  }): Promise<Record<LocalWhisperModel, SidecarModelStatusResponse>> {
    const sidecar = await this.resolveRuntime(preferGpu);
    return await sidecar.listModelStatuses(models, validate);
  }

  async getModelStatus({
    model,
    preferGpu,
    validate = true,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
    validate?: boolean;
  }): Promise<SidecarModelStatusResponse> {
    const sidecar = await this.resolveRuntime(preferGpu);
    return await sidecar.getModelStatus(model, validate);
  }

  async downloadModel({
    model,
    preferGpu,
    onProgress,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
    onProgress?: (snapshot: SidecarDownloadSnapshot) => void;
  }): Promise<SidecarModelStatusResponse | null> {
    const sidecar =
      this.downloadOwners.get(model) ?? (await this.resolveRuntime(preferGpu));
    this.downloadOwners.set(model, sidecar);

    try {
      const status = await sidecar.downloadModel(model, onProgress);
      if (status) {
        this.downloadOwners.delete(model);
      }
      return status;
    } catch (error) {
      this.downloadOwners.delete(model);
      throw error;
    }
  }

  async pauseModelDownload({
    model,
    preferGpu,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
  }): Promise<SidecarDownloadSnapshot> {
    const sidecar =
      this.downloadOwners.get(model) ?? (await this.resolveRuntime(preferGpu));
    return await sidecar.pauseDownload(model);
  }

  async cancelModelDownload({
    model,
    preferGpu,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
  }): Promise<SidecarDownloadSnapshot> {
    const sidecar =
      this.downloadOwners.get(model) ?? (await this.resolveRuntime(preferGpu));
    try {
      return await sidecar.cancelDownload(model);
    } finally {
      this.downloadOwners.delete(model);
      this.cpuSidecar.invalidateModelReadiness(model);
      this.gpuSidecar.invalidateModelReadiness(model);
    }
  }

  async deleteModel({
    model,
    preferGpu,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
  }): Promise<SidecarModelStatusResponse> {
    const sidecar = await this.resolveRuntime(preferGpu);
    const result = await sidecar.deleteModel(model);
    this.cpuSidecar.invalidateModelReadiness(model);
    this.gpuSidecar.invalidateModelReadiness(model);
    return result;
  }

  async transcribe(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    const sidecar = await this.resolveRuntime(input.preferGpu);

    try {
      return await sidecar.transcribe(input);
    } catch (error) {
      if (
        input.preferGpu &&
        sidecar === this.gpuSidecar &&
        this.shouldFallbackToCpu(error)
      ) {
        this.markGpuUnavailable(error);
        return await this.cpuSidecar.transcribe({
          ...input,
          deviceId: undefined,
        });
      }

      throw error;
    }
  }

  async createStreamingSession(
    input: LocalSidecarStreamingSessionInput,
  ): Promise<LocalSidecarStreamingSession> {
    const sidecar = await this.resolveRuntime(input.preferGpu);

    try {
      return await sidecar.createStreamingSession(input);
    } catch (error) {
      if (
        input.preferGpu &&
        sidecar === this.gpuSidecar &&
        this.shouldFallbackToCpu(error)
      ) {
        this.markGpuUnavailable(error);
        return await this.cpuSidecar.createStreamingSession({
          ...input,
          deviceId: undefined,
        });
      }

      throw error;
    }
  }

  private async resolveRuntime(
    preferGpu: boolean,
  ): Promise<LocalTranscriptionSidecar> {
    if (preferGpu && (await this.gpuIsUsable())) {
      try {
        await this.gpuSidecar.ensureStarted();
        return this.gpuSidecar;
      } catch (error) {
        this.markGpuUnavailable(error);
      }
    }

    await this.cpuSidecar.ensureStarted();
    return this.cpuSidecar;
  }

  private shouldFallbackToCpu(error: unknown): boolean {
    if (error instanceof SidecarRequestError) {
      return error.status === undefined;
    }

    const message = toErrorMessage(error).toLowerCase();
    return message.includes("sidecar") || message.includes("request failed");
  }

  private markGpuUnavailable(error: unknown): void {
    this.gpuUnavailable = true;
    getLogger().warning(
      `[local-sidecar:gpu] unavailable, falling back to CPU (${toErrorMessage(error)})`,
    );
  }
}

let localTranscriptionFacade: LocalTranscriptionSidecarFacade | null = null;

export const getLocalTranscriptionSidecarManager =
  (): LocalTranscriptionSidecarFacade => {
    localTranscriptionFacade ??= new LocalTranscriptionSidecarFacade();
    return localTranscriptionFacade;
  };
