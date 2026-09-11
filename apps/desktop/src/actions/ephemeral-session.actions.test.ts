import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import {
  EPHEMERAL_SESSION_ENDED_EVENT,
  EPHEMERAL_SESSION_STARTED_EVENT,
} from "@maus-inc/desktop-utils";
import { getAppState, produceAppState } from "../store";
import {
  endEphemeralSession,
  startEphemeralSession,
} from "./ephemeral-session.actions";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("../store");
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    verbose: vi.fn(),
  }),
}));

type LocalSlice = { ephemeralSessionActive: boolean };

let local: LocalSlice;

const emittedPayload = (callIndex = 0) =>
  (emit as ReturnType<typeof vi.fn>).mock.calls[callIndex][1] as Record<
    string,
    string
  >;

describe("ephemeral-session.actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    local = { ephemeralSessionActive: false };
    (getAppState as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      local,
    }));
    (produceAppState as ReturnType<typeof vi.fn>).mockImplementation(
      (fn: (draft: { local: LocalSlice }) => void) => {
        fn({ local });
      },
    );
    (emit as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(),
    );
  });

  it("activates the session and emits the started event", async () => {
    await startEphemeralSession();

    expect(local.ephemeralSessionActive).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(EPHEMERAL_SESSION_STARTED_EVENT, {
      startedAt: expect.any(String),
    });
  });

  it("emits an ISO 8601 timestamp", async () => {
    await startEphemeralSession();

    const { startedAt } = emittedPayload();
    expect(new Date(startedAt).toISOString()).toBe(startedAt);
  });

  it("deactivates the session and emits the ended event", async () => {
    await startEphemeralSession();
    await endEphemeralSession();

    expect(local.ephemeralSessionActive).toBe(false);
    expect(emit).toHaveBeenLastCalledWith(EPHEMERAL_SESSION_ENDED_EVENT, {
      endedAt: expect.any(String),
    });
  });

  it("does not emit again when the session is already active", async () => {
    await startEphemeralSession();
    await startEphemeralSession();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(local.ephemeralSessionActive).toBe(true);
  });

  it("does not emit when ending a session that never started", async () => {
    await endEphemeralSession();

    expect(emit).not.toHaveBeenCalled();
    expect(local.ephemeralSessionActive).toBe(false);
  });

  it("keeps the session active when the broadcast fails", async () => {
    (emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no event bus"),
    );

    await expect(startEphemeralSession()).resolves.toBeUndefined();

    expect(local.ephemeralSessionActive).toBe(true);
  });
});
