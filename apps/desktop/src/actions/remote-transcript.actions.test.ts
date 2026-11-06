import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  create: vi.fn(),
  produce: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ createTranscription: mocks.create }),
}));
vi.mock("../store", () => ({
  getAppState: () => ({}),
  produceAppState: mocks.produce,
}));
vi.mock("../utils/id.utils", () => ({ createId: () => "id" }));
vi.mock("../utils/incognito.utils", () => ({
  isPersistenceAllowed: () => true,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn() }),
}));
vi.mock("../utils/output-routing.utils", () => ({
  insertLocalTranscriptOutputViaPaste: mocks.insert,
}));
vi.mock("../utils/user.utils", () => ({ getMyEffectiveUserId: () => "user" }));
vi.mock("./app.actions", () => ({ showSnackbar: mocks.toast }));
import { handleRemoteFinalTextReceived } from "./remote-transcript.actions";

const payload = {
  senderDeviceId: "device",
  eventId: "event",
  text: " hello ",
  mode: "text",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("remote transcript ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.insert.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({ id: "stored" });
  });
  afterEach(() => vi.useRealTimers());

  it("does not insert after ownership changes during the initial delay", async () => {
    let current = true;
    const promise = handleRemoteFinalTextReceived(payload, () => current);
    current = false;
    await vi.advanceTimersByTimeAsync(20);
    await promise;
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not store an old transcript after an in-flight insertion returns", async () => {
    let finish!: () => void;
    let current = true;
    mocks.insert.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const promise = handleRemoteFinalTextReceived(payload, () => current);
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.insert).toHaveBeenCalledWith("hello ", null);
    current = false;
    finish();
    await promise;
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not publish a late database result into the successor state", async () => {
    let finish!: (value: { id: string }) => void;
    let current = true;
    mocks.create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const promise = handleRemoteFinalTextReceived(payload, () => current);
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.create).toHaveBeenCalledOnce();
    current = false;
    finish({ id: "stored" });
    await promise;
    expect(mocks.produce).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("preserves the unscoped delivery flow", async () => {
    const promise = handleRemoteFinalTextReceived(payload);
    await vi.advanceTimersByTimeAsync(20);
    await promise;
    expect(mocks.insert).toHaveBeenCalledWith("hello ", null);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.produce).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledOnce();
  });
});
