// @vitest-environment jsdom
import type { User } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { LocalUserRepo } from "./user.repo";

/**
 * Regression tests for the IPC boundary between the TS user payload and
 * the Rust `User` domain. The PR added a non-Option `interaction_feedback_volume:
 * f32` to Rust; if the TS user object lacks the field, `toLocalUser`
 * emits `"interactionFeedbackVolume": null`. Serde's `default` attribute
 * only covers MISSING keys, not null values (serde-rs/serde#1098), so
 * the Rust field is now `Option<f32>` and the boundary must be tolerant
 * of explicit null. These tests lock in the contract on both sides.
 */

const minimalUser: User = {
  id: LOCAL_USER_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  name: "Test",
  bio: null,
  onboarded: false,
  playInteractionChime: true,
  hasFinishedTutorial: false,
  wordsThisMonth: 0,
  wordsTotal: 0,
};

const capturedInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => capturedInvoke(...args),
  Resource: class {},
}));

const seedState = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.userById[LOCAL_USER_ID] = minimalUser;
  setAppState(state, true);
};

describe("user repo IPC boundary for interactionFeedbackVolume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedState();
  });

  it("emits an explicit null when the TS user lacks the field (onboarding path)", async () => {
    capturedInvoke.mockResolvedValue({
      id: LOCAL_USER_ID,
      name: "Test",
      bio: "",
      onboarded: false,
      playInteractionChime: true,
      // interactionFeedbackVolume deliberately absent: simulates the
      // onboarding literal that does not set the field.
    });
    const repo = new LocalUserRepo();
    await repo.setMyUser(minimalUser);
    const sent = capturedInvoke.mock.calls[0];
    expect(sent?.[0]).toBe("user_set_one");
    const userArg = sent?.[1]?.user as {
      interactionFeedbackVolume?: number | null;
    };
    // The payload must carry the key with a null value, so the Rust
    // `Option<f32>` deserializes cleanly. It must NOT omit the key
    // (a non-Option Rust field would have rejected the null).
    expect(userArg).toHaveProperty("interactionFeedbackVolume");
    expect(userArg.interactionFeedbackVolume).toBeNull();
  });

  it("emits the persisted volume when the TS user carries a value", async () => {
    capturedInvoke.mockResolvedValue({
      id: LOCAL_USER_ID,
      name: "Test",
      bio: "",
      onboarded: false,
      playInteractionChime: true,
      interactionFeedbackVolume: 0.42,
    });
    const repo = new LocalUserRepo();
    await repo.setMyUser({
      ...minimalUser,
      interactionFeedbackVolume: 0.42,
    });
    const userArg = capturedInvoke.mock.calls[0]?.[1]?.user as {
      interactionFeedbackVolume?: number | null;
    };
    expect(userArg.interactionFeedbackVolume).toBe(0.42);
  });
});

/**
 * `createdAt` and `onboardedAt` were fabricated as `new Date().toISOString()`
 * on every read because no column backed them. The value moved with the clock,
 * which pinned the release-dialog gate shut for everyone and reported a
 * tenured account as brand new. The clock is pinned here so any dependence on
 * "now" is a hard failure rather than a flake.
 */
describe("user repo profile timestamps", () => {
  const ACCOUNT_CREATED_AT_KEY = "mausvoice:account-created-at";
  const ONBOARDED_AT_KEY = "mausvoice:onboarded-at";
  const EPOCH = new Date(0).toISOString();

  const CREATED = "2026-01-05T09:00:00.000Z";
  const ONBOARDED = "2026-01-06T09:00:00.000Z";

  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: LOCAL_USER_ID,
    name: "Test",
    bio: "",
    onboarded: true,
    playInteractionChime: true,
    ...overrides,
  });

  const setAnchor = (key: string, value: string) =>
    window.localStorage.setItem(key, JSON.stringify(value));

  const readAnchor = (key: string) => window.localStorage.getItem(key);

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("keeps createdAt stable across later reads", async () => {
    capturedInvoke.mockResolvedValue(
      storedRow({ createdAt: CREATED, onboardedAt: ONBOARDED }),
    );
    const repo = new LocalUserRepo();

    const first = await repo.getMyUser();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const second = await repo.getMyUser();

    expect(first?.createdAt).toBe(CREATED);
    expect(second?.createdAt).toBe(CREATED);
  });

  it("keeps onboardedAt stable across later reads", async () => {
    capturedInvoke.mockResolvedValue(
      storedRow({ createdAt: CREATED, onboardedAt: ONBOARDED }),
    );
    const repo = new LocalUserRepo();

    const first = await repo.getMyUser();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const second = await repo.getMyUser();

    expect(first?.onboardedAt).toBe(ONBOARDED);
    expect(second?.onboardedAt).toBe(ONBOARDED);
  });

  it("re-saving keeps the ORIGINAL timestamp instead of stamping now", async () => {
    capturedInvoke.mockResolvedValue(
      storedRow({ createdAt: CREATED, onboardedAt: ONBOARDED }),
    );
    const repo = new LocalUserRepo();

    const loaded = await repo.getMyUser();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    capturedInvoke.mockResolvedValue(
      storedRow({ createdAt: CREATED, onboardedAt: ONBOARDED }),
    );
    await repo.setMyUser({ ...(loaded as User), name: "Renamed" });

    const sent = capturedInvoke.mock.calls.at(-1)?.[1]?.user as {
      createdAt: string;
      onboardedAt: string | null;
    };
    expect(sent.createdAt).toBe(CREATED);
    expect(sent.onboardedAt).toBe(ONBOARDED);
  });

  it("reports epoch and null for a legacy install with no anchor", async () => {
    // A profile row that predates migration 89 and the anchors. Its age is
    // genuinely unknown: epoch is the honest floor for createdAt and keeps the
    // release dialog reachable, while onboardedAt stays null so analytics
    // reports "unknown" rather than a fabricated date.
    capturedInvoke.mockResolvedValue(storedRow());
    const repo = new LocalUserRepo();

    const loaded = await repo.getMyUser();

    expect(loaded?.createdAt).toBe(EPOCH);
    expect(loaded?.onboardedAt).toBeNull();
  });

  it("prefers the write-once anchor when the column is null", async () => {
    setAnchor(ACCOUNT_CREATED_AT_KEY, CREATED);
    setAnchor(ONBOARDED_AT_KEY, ONBOARDED);
    capturedInvoke.mockResolvedValue(storedRow());
    const repo = new LocalUserRepo();

    const loaded = await repo.getMyUser();

    expect(loaded?.createdAt).toBe(CREATED);
    expect(loaded?.onboardedAt).toBe(ONBOARDED);
  });

  it("plants the anchor on first save and reuses it on later reads", async () => {
    const repo = new LocalUserRepo();
    capturedInvoke.mockResolvedValue(storedRow());

    await repo.setMyUser({ ...minimalUser, createdAt: CREATED });

    expect(readAnchor(ACCOUNT_CREATED_AT_KEY)).toBe(JSON.stringify(CREATED));

    // A later read of a row whose column is still null recovers the anchor
    // rather than inventing "now".
    vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
    const loaded = await repo.getMyUser();
    expect(loaded?.createdAt).toBe(CREATED);
  });

  it("never overwrites an anchor that already exists", async () => {
    setAnchor(ACCOUNT_CREATED_AT_KEY, CREATED);
    const repo = new LocalUserRepo();
    capturedInvoke.mockResolvedValue(storedRow());

    await repo.setMyUser({
      ...minimalUser,
      createdAt: "2026-12-25T00:00:00.000Z",
    });

    expect(readAnchor(ACCOUNT_CREATED_AT_KEY)).toBe(JSON.stringify(CREATED));
  });
});
