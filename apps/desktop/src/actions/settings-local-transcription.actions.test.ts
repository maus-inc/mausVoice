import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: "local",
  download: vi.fn(),
  pause: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => ({
    downloadModel: mocks.download,
    pauseModelDownload: mocks.pause,
    cancelModelDownload: mocks.cancel,
    listModelStatuses: mocks.list,
  }),
}));
vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  getEffectiveTranscriptionMode: () => mocks.mode,
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: mocks.error }));

import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import {
  cancelLocalTranscriptionModelDownload,
  downloadLocalTranscriptionModel,
  resumeLocalTranscriptionModelDownload,
  pauseLocalTranscriptionModelDownload,
} from "./settings-local-transcription.actions";

const paused = {
  jobId: "job",
  model: "tiny" as const,
  status: "paused" as const,
  bytesDownloaded: 10,
  totalBytes: 20,
  progress: 0.5,
  error: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "local";
  mocks.pause.mockResolvedValue(paused);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({});
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

describe("local model download controls", () => {
  it("starts only one request before the first progress snapshot", async () => {
    let finish!: (value: null) => void;
    mocks.download.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = downloadLocalTranscriptionModel("tiny");
    const second = downloadLocalTranscriptionModel("tiny");
    expect(mocks.download).toHaveBeenCalledTimes(1);
    finish(null);
    await Promise.all([first, second]);
  });

  it("ignores old progress after pausing and immediately resuming", async () => {
    const callbacks: Array<(value: typeof paused) => void> = [];
    const finishes: Array<(value: null) => void> = [];
    mocks.download.mockImplementation(
      ({ onProgress }: { onProgress: (value: typeof paused) => void }) => {
        callbacks.push(onProgress);
        return new Promise((resolve) => {
          finishes.push(resolve);
        });
      },
    );
    const first = downloadLocalTranscriptionModel("tiny");
    callbacks[0](paused);
    await pauseLocalTranscriptionModelDownload("tiny");
    const second = resumeLocalTranscriptionModelDownload("tiny");
    expect(mocks.download).toHaveBeenCalledTimes(2);
    callbacks[1]({ ...paused, jobId: "new", status: "paused" });
    callbacks[0]({ ...paused, jobId: "old" });
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny?.jobId,
    ).toBe("new");
    finishes[0](null);
    finishes[1](null);
    await Promise.all([first, second]);
  });

  it("ignores late progress after cancellation completes", async () => {
    let progress!: (value: typeof paused) => void;
    let finish!: (value: null) => void;
    mocks.download.mockImplementationOnce(
      ({ onProgress }: { onProgress: (value: typeof paused) => void }) => {
        progress = onProgress;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const first = downloadLocalTranscriptionModel("tiny");
    progress(paused);
    await cancelLocalTranscriptionModelDownload("tiny");
    progress(paused);
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny,
    ).toBeUndefined();
    finish(null);
    await first;
  });

  it("does not resurrect a paused snapshot after cancellation wins", async () => {
    let finishPause!: (snapshot: typeof paused) => void;
    mocks.pause.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPause = resolve;
      }),
    );
    const pause = pauseLocalTranscriptionModelDownload("tiny");
    await cancelLocalTranscriptionModelDownload("tiny");
    finishPause(paused);
    await pause;
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny,
    ).toBeUndefined();
  });

  it("blocks duplicate cancellation and resume until cancellation settles", async () => {
    let finishCancel!: () => void;
    mocks.cancel.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCancel = resolve;
      }),
    );
    const first = cancelLocalTranscriptionModelDownload("tiny");
    const second = cancelLocalTranscriptionModelDownload("tiny");
    await resumeLocalTranscriptionModelDownload("tiny");
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();
    finishCancel();
    await Promise.all([first, second]);
  });

  it("keeps tracking a worker when pause reports that finalization is already running", async () => {
    let progress!: (
      value:
        typeof paused | (Omit<typeof paused, "status"> & { status: "running" }),
    ) => void;
    let finish!: (value: null) => void;
    mocks.download.mockImplementationOnce(({ onProgress }) => {
      progress = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    mocks.pause.mockResolvedValueOnce({ ...paused, status: "running" });
    const first = downloadLocalTranscriptionModel("tiny");
    progress({ ...paused, status: "running" });
    await pauseLocalTranscriptionModelDownload("tiny");
    progress({ ...paused, jobId: "latest", status: "running" });
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny?.jobId,
    ).toBe("latest");
    finish(null);
    await first;
  });

  it("waits for a newly starting sidecar job before sending its cancellation", async () => {
    let progress!: (snapshot: typeof paused) => void;
    let finish!: (value: null) => void;
    mocks.download.mockImplementationOnce(({ onProgress }) => {
      progress = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const download = downloadLocalTranscriptionModel("tiny");
    const cancel = cancelLocalTranscriptionModelDownload("tiny");
    await Promise.resolve();
    expect(mocks.cancel).not.toHaveBeenCalled();
    progress(paused);
    await cancel;
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    finish(null);
    await download;
  });

  it("does not send cancellation for a start that fails before creating a job", async () => {
    let fail!: (error: Error) => void;
    mocks.download.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const download = downloadLocalTranscriptionModel("tiny");
    const cancel = cancelLocalTranscriptionModelDownload("tiny");
    fail(new Error("sidecar could not start"));
    await Promise.all([download, cancel]);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("waits for a starting job before sending pause", async () => {
    let progress!: (snapshot: typeof paused) => void;
    let finish!: (value: null) => void;
    mocks.download.mockImplementationOnce(({ onProgress }) => {
      progress = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const download = downloadLocalTranscriptionModel("tiny");
    const pause = pauseLocalTranscriptionModelDownload("tiny");
    await Promise.resolve();
    expect(mocks.pause).not.toHaveBeenCalled();
    progress(paused);
    await pause;
    expect(mocks.pause).toHaveBeenCalledOnce();
    finish(null);
    await download;
  });

  it("does nothing outside local transcription mode", async () => {
    mocks.mode = "api";
    await pauseLocalTranscriptionModelDownload("tiny");
    await cancelLocalTranscriptionModelDownload("tiny");
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("stores the pause snapshot with the selected device preference", async () => {
    await pauseLocalTranscriptionModelDownload("tiny");
    expect(mocks.pause).toHaveBeenCalledWith({
      model: "tiny",
      preferGpu: false,
    });
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny,
    ).toEqual(paused);
  });

  it("reports pause failure without discarding existing state", async () => {
    produceAppState((state) => {
      state.settings.aiTranscription.localModelManagement.modelDownloads.tiny =
        paused;
    });
    mocks.pause.mockRejectedValue(new Error("offline"));
    await pauseLocalTranscriptionModelDownload("tiny");
    expect(mocks.error).toHaveBeenCalledWith(
      "Unable to pause download for 'tiny': Error: offline",
    );
    expect(
      getAppState().settings.aiTranscription.localModelManagement.modelDownloads
        .tiny,
    ).toEqual(paused);
  });

  it.each([false, true])(
    "clears and refreshes after cancellation, including failure (%s)",
    async (fail) => {
      produceAppState((state) => {
        state.settings.aiTranscription.localModelManagement.modelDownloads.tiny =
          paused;
      });
      if (fail) mocks.cancel.mockRejectedValue(new Error("offline"));
      await cancelLocalTranscriptionModelDownload("tiny");
      expect(mocks.cancel).toHaveBeenCalledWith({
        model: "tiny",
        preferGpu: false,
      });
      expect(
        getAppState().settings.aiTranscription.localModelManagement
          .modelDownloads.tiny,
      ).toBeUndefined();
      expect(mocks.list).toHaveBeenCalledOnce();
      if (fail)
        expect(mocks.error).toHaveBeenCalledWith(
          "Unable to cancel download for 'tiny': Error: offline",
        );
      else expect(mocks.error).not.toHaveBeenCalled();
    },
  );
});
