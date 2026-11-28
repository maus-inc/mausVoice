import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalDataWriteLease,
  LocalDataWriteRelease,
} from "../utils/local-data-write-gate";
import { sampleTranscription } from "../test/helpers/transcription-fixture";

const {
  assertLocalDataWriteLease,
  beginLocalDataWrite,
  createId,
  createTranscription,
  getAppState,
  getLogger,
  getMyEffectiveUserId,
  insertLocalTranscriptOutputViaPaste,
  isLocalDataClearRequested,
  isPersistenceAllowed,
  produceAppState,
  showSnackbar,
  warning,
} = vi.hoisted(() => ({
  assertLocalDataWriteLease: vi.fn(),
  beginLocalDataWrite: vi.fn(),
  createId: vi.fn(),
  createTranscription: vi.fn(),
  getAppState: vi.fn(),
  getLogger: vi.fn(),
  getMyEffectiveUserId: vi.fn(),
  insertLocalTranscriptOutputViaPaste: vi.fn(),
  isLocalDataClearRequested: vi.fn(),
  isPersistenceAllowed: vi.fn(),
  produceAppState: vi.fn(),
  showSnackbar: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../utils/local-data-write-gate", () => ({
  assertLocalDataWriteLease,
  beginLocalDataWrite,
  isLocalDataClearRequested,
}));

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ createTranscription }),
}));

vi.mock("../store", () => ({ getAppState, produceAppState }));
vi.mock("../utils/id.utils", () => ({ createId }));
vi.mock("../utils/incognito.utils", () => ({ isPersistenceAllowed }));
vi.mock("../utils/log.utils", () => ({ getLogger }));
vi.mock("../utils/output-routing.utils", () => ({
  insertLocalTranscriptOutputViaPaste,
}));
vi.mock("../utils/user.utils", () => ({ getMyEffectiveUserId }));
vi.mock("./app.actions", () => ({ showSnackbar }));

const { handleRemoteFinalTextReceived } =
  await import("./remote-transcript.actions");

const payload = {
  senderDeviceId: "sender-1",
  eventId: "event-1",
  text: "A remote transcript",
  mode: "text",
  createdAt: "2026-08-01T00:00:00.000Z",
};

let lease: LocalDataWriteLease;
let releaseWrite: LocalDataWriteRelease;

beforeEach(() => {
  vi.clearAllMocks();
  lease = {} as LocalDataWriteLease;
  releaseWrite = Object.assign(vi.fn(), { lease }) as LocalDataWriteRelease;
  beginLocalDataWrite.mockReturnValue(releaseWrite);
  createId.mockReturnValue("remote-transcription-1");
  createTranscription.mockResolvedValue(sampleTranscription("stored-1"));
  getAppState.mockReturnValue({});
  getLogger.mockReturnValue({ warning });
  getMyEffectiveUserId.mockReturnValue("local-user");
  insertLocalTranscriptOutputViaPaste.mockResolvedValue("pasted");
  isLocalDataClearRequested.mockReturnValue(false);
  isPersistenceAllowed.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("handleRemoteFinalTextReceived", () => {
  it("does not emit or persist a remote transcript when clearing blocks new leases", async () => {
    beginLocalDataWrite.mockReturnValue(null);

    await expect(handleRemoteFinalTextReceived(payload)).resolves.toBe(false);

    expect(insertLocalTranscriptOutputViaPaste).not.toHaveBeenCalled();
    expect(createTranscription).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it("stops a leased remote event when clearing starts during its delay", async () => {
    vi.useFakeTimers();
    isLocalDataClearRequested.mockReturnValue(true);

    const operation = handleRemoteFinalTextReceived(payload);
    await vi.advanceTimersByTimeAsync(20);

    await expect(operation).resolves.toBe(false);
    expect(insertLocalTranscriptOutputViaPaste).not.toHaveBeenCalled();
    expect(createTranscription).not.toHaveBeenCalled();
    expect(showSnackbar).not.toHaveBeenCalled();
    expect(releaseWrite).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("uses one active lease for insertion, local storage, and store updates", async () => {
    await expect(handleRemoteFinalTextReceived(payload)).resolves.toBe(true);

    expect(assertLocalDataWriteLease).toHaveBeenCalledWith(lease);
    expect(insertLocalTranscriptOutputViaPaste).toHaveBeenCalledWith(
      "A remote transcript ",
      null,
    );
    expect(createTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "remote-transcription-1",
        transcript: "A remote transcript",
        remoteStatus: "received",
        remoteDeviceId: "sender-1",
      }),
      lease,
    );
    expect(produceAppState).toHaveBeenCalledWith(expect.any(Function), lease);
    expect(showSnackbar).toHaveBeenCalledWith("Remote transcript inserted.", {
      mode: "success",
    });
    expect(releaseWrite).toHaveBeenCalledOnce();
  });
});
