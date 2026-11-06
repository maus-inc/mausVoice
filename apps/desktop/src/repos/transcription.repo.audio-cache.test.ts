import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
import { LocalTranscriptionRepo } from "./transcription.repo";
import { transcriptionAudioCache } from "../utils/transcription-audio-cache";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";

const audio = { samples: [0, 0], sampleRate: 16000 };
const repo = new LocalTranscriptionRepo();
beforeEach(() => {
  transcriptionAudioCache.invalidate();
  invoke.mockReset();
  invoke.mockImplementation(async (command) =>
    command === "transcription_audio_load"
      ? audio
      : command === "purge_stale_transcription_audio"
        ? ["a"]
        : undefined,
  );
});
it("reuses samples across repository instances and invalidates deletion", async () => {
  await repo.loadTranscriptionAudio("a");
  await new LocalTranscriptionRepo().loadTranscriptionAudio("a");
  expect(
    invoke.mock.calls.filter(
      ([command]) => command === "transcription_audio_load",
    ),
  ).toHaveLength(1);
  await repo.deleteTranscription("a");
  await repo.loadTranscriptionAudio("a");
  expect(
    invoke.mock.calls.filter(
      ([command]) => command === "transcription_audio_load",
    ),
  ).toHaveLength(2);
});
it("invalidates the clips removed by managed-audio purging", async () => {
  await repo.loadTranscriptionAudio("a");
  await repo.purgeStaleAudio();
  await repo.loadTranscriptionAudio("a");
  expect(
    invoke.mock.calls.filter(
      ([command]) => command === "transcription_audio_load",
    ),
  ).toHaveLength(2);
});
it("clear invalidates a pending read before waiting for its lease", async () => {
  let resolve!: (value: typeof audio) => void;
  invoke.mockReturnValue(
    new Promise<typeof audio>((done) => {
      resolve = done;
    }),
  );
  const pending = repo.loadTranscriptionAudio("a");
  const rejection = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  const clearing = beginLocalDataClear();
  resolve(audio);
  await rejection;
  const release = await clearing;
  try {
    await expect(repo.loadTranscriptionAudio("a")).rejects.toThrow(
      "Local data is being cleared",
    );
    expect(invoke).toHaveBeenCalledOnce();
  } finally {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    release();
  }
});
it("deletion cannot release preload capacity before native reads settle", async () => {
  let finish!: (value: typeof audio) => void;
  const reading = new Promise<typeof audio>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation(async (command) =>
    command === "transcription_audio_load" ? reading : undefined,
  );
  const a = repo.loadTranscriptionAudio("a");
  const b = repo.loadTranscriptionAudio("b");
  const settled = Promise.allSettled([a, b]);
  try {
    await repo.deleteTranscription("a");
    expect(transcriptionAudioCache.canWarm()).toBe(false);
  } finally {
    finish(audio);
    await settled;
  }
  expect(await settled).toEqual([
    {
      status: "rejected",
      reason: expect.objectContaining({ name: "AbortError" }),
    },
    { status: "fulfilled", value: audio },
  ]);
  expect(transcriptionAudioCache.canWarm()).toBe(true);
});
it.each(["createTranscription", "updateTranscription"] as const)(
  "%s discards samples loaded while the mutation is pending",
  async (method) => {
    const transcription = {
      id: "a",
      transcript: "test",
      createdAt: "2026-11-05T00:00:00.000Z",
      createdByUserId: "test-user",
      isDeleted: false,
    };
    let release!: () => void;
    const mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let storedAudio = audio;
    invoke.mockImplementation(async (command, args) => {
      if (command === "transcription_audio_load") return storedAudio;
      if (
        command === "transcription_create" ||
        command === "transcription_update"
      ) {
        await mutation;
        return args.transcription;
      }
    });
    await repo.loadTranscriptionAudio("a");
    const updating = repo[method](transcription);
    await repo.loadTranscriptionAudio("a");
    storedAudio = { ...audio, samples: [0.5, -0.5] };
    release();
    await updating;
    expect(await repo.loadTranscriptionAudio("a")).toEqual(storedAudio);
  },
);
