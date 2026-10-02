import { describe, expect, it } from "vitest";
import { nextAnnouncement } from "./AgentLiveAnnouncer";

const MESSAGES = {
  replying: "replying",
  finished: "finished",
  newMessage: "new-message",
};

const state = (agentRunning: boolean, messageCount: number) => ({
  agentRunning,
  messageCount,
});

describe("nextAnnouncement", () => {
  it("announces a run starting", () => {
    expect(nextAnnouncement(state(false, 2), state(true, 2), MESSAGES)).toBe(
      "replying",
    );
  });

  it("announces a run finishing", () => {
    expect(nextAnnouncement(state(true, 2), state(false, 2), MESSAGES)).toBe(
      "finished",
    );
  });

  it("announces an arrived message", () => {
    expect(nextAnnouncement(state(true, 2), state(true, 3), MESSAGES)).toBe(
      "new-message",
    );
  });

  it("stays silent when nothing changed", () => {
    expect(
      nextAnnouncement(state(true, 2), state(true, 2), MESSAGES),
    ).toBeNull();
  });

  it("stays silent on the very first render, which is not a transition", () => {
    // A conversation that opens mid-run must not announce a run the user never
    // saw begin.
    expect(
      nextAnnouncement(state(true, 4), state(true, 4), MESSAGES),
    ).toBeNull();
  });

  it("prefers the finish when a run settles in the same tick a message lands", () => {
    expect(nextAnnouncement(state(true, 2), state(false, 3), MESSAGES)).toBe(
      "finished",
    );
  });

  it("prefers the start when a run begins in the same tick a message lands", () => {
    expect(nextAnnouncement(state(false, 2), state(true, 3), MESSAGES)).toBe(
      "replying",
    );
  });

  it("stays silent when the message count drops, which is a conversation switch", () => {
    expect(
      nextAnnouncement(state(true, 5), state(true, 1), MESSAGES),
    ).toBeNull();
  });
});
