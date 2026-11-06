import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeSidecar = () => ({
    ensureStarted: vi.fn(async () => undefined),
    downloadModel: vi.fn(),
    pauseDownload: vi.fn(async () => ({ status: "paused" })),
    cancelDownload: vi.fn(async () => ({ status: "canceled" })),
    invalidateModelReadiness: vi.fn(),
  });
  return { cpu: makeSidecar(), gpu: makeSidecar() };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => [{ backend: "Vulkan", deviceType: "DiscreteGpu" }]),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn(), verbose: vi.fn() }),
}));
vi.mock("./local-transcription.sidecar", () => ({
  LocalTranscriptionSidecar: class {
    constructor(mode: string) {
      return mode === "cpu" ? mocks.cpu : mocks.gpu;
    }
  },
  SidecarRequestError: class extends Error {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it("keeps the resumed worker's sidecar owner if the older worker fails", async () => {
  const { getLocalTranscriptionSidecarManager } = await import("./index");
  const manager = getLocalTranscriptionSidecarManager();
  let rejectOld!: (error: Error) => void;
  let finishNew!: (status: null) => void;
  mocks.cpu.downloadModel
    .mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishNew = resolve;
      }),
    );
  const old = manager.downloadModel({ model: "tiny", preferGpu: false });
  await vi.waitFor(() =>
    expect(mocks.cpu.downloadModel).toHaveBeenCalledTimes(1),
  );
  const current = manager.downloadModel({ model: "tiny", preferGpu: false });
  await vi.waitFor(() =>
    expect(mocks.cpu.downloadModel).toHaveBeenCalledTimes(2),
  );
  rejectOld(new Error("old worker failed"));
  await expect(old).rejects.toThrow("old worker failed");
  await manager.pauseModelDownload({ model: "tiny", preferGpu: true });
  expect(mocks.cpu.pauseDownload).toHaveBeenCalledOnce();
  expect(mocks.gpu.pauseDownload).not.toHaveBeenCalled();
  finishNew(null);
  await current;
});
