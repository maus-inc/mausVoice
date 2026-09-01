import type { User } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
