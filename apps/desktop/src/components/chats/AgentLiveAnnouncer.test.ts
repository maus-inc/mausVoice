import { describe, expect, it } from "vitest";
import { nextAnnouncement } from "./AgentLiveAnnouncer";

const MESSAGES = {
  replying: "replying",
  finished: "finished",
  newMessage: "new-message",
};

type Input = {
  agentRunning: boolean;
  latestMessageId: string | null;
  latestMessageRole: string | null;
};

const state = (
  agentRunning: boolean,
  latestMessageId: string | null = "m1",
  latestMessageRole: string | null = "assistant",
): Input => ({ agentRunning, latestMessageId, latestMessageRole });

describe("nextAnnouncement", () => {
  it("announces a run starting", () => {
    expect(nextAnnouncement(state(false), state(true), MESSAGES)).toBe(
      "replying",
    );
  });

  it("announces a run finishing", () => {
    expect(nextAnnouncement(state(true), state(false), MESSAGES)).toBe(
      "finished",
    );
  });

  it("announces an arrived assistant message", () => {
    expect(
      nextAnnouncement(state(true, "m1"), state(true, "m2"), MESSAGES),
    ).toBe("new-message");
  });

  it("stays silent when nothing changed", () => {
    expect(nextAnnouncement(state(true), state(true), MESSAGES)).toBeNull();
  });

  it("stays silent on the first render, which is not a transition", () => {
    // A conversation that opens mid-run must not announce a run the user never
    // saw begin.
    expect(nextAnnouncement(state(true), state(true), MESSAGES)).toBeNull();
  });

  it("prefers the finish when a run settles in the same tick a message lands", () => {
    expect(
      nextAnnouncement(state(true, "m1"), state(false, "m2"), MESSAGES),
    ).toBe("finished");
  });

  it("prefers the start when a run begins in the same tick a message lands", () => {
    expect(
      nextAnnouncement(state(false, "m1"), state(true, "m2"), MESSAGES),
    ).toBe("replying");
  });

  it("does not announce saved history as new messages", () => {
    // Opening a chat loads its messages at once, and a saved conversation
    // usually ends with the assistant's reply. Announcing that on open would
    // tell the user a reply had just arrived when it had not. Only the
    // first-id guard catches this, since the role check alone would not.
    const before = state(true, null, null);
    const after = state(true, "m9", "assistant");
    expect(nextAnnouncement(before, after, MESSAGES)).toBeNull();
  });

  it("does not announce the user's own message as new", () => {
    expect(
      nextAnnouncement(state(true, "m1"), state(true, "m2", "user"), MESSAGES),
    ).toBeNull();
  });

  it("announces the assistant reply that follows the user's own send", () => {
    expect(
      nextAnnouncement(
        state(true, "m2", "user"),
        state(true, "m3", "assistant"),
        MESSAGES,
      ),
    ).toBe("new-message");
  });

  it("stays silent when the newest message disappears, which is a conversation switch", () => {
    expect(
      nextAnnouncement(
        state(true, "m5", "assistant"),
        state(true, null, null),
        MESSAGES,
      ),
    ).toBeNull();
  });
});
