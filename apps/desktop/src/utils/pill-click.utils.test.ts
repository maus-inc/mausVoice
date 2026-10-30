import { describe, expect, it } from "vitest";
import { resolvePillBodyClickIntent } from "./pill-click.utils";

const base = {
  isMainWindow: true,
  isDictationInteractable: true,
  isPaused: false,
};

describe("resolvePillBodyClickIntent", () => {
  it("resumes instead of toggling when the session is paused", () => {
    expect(resolvePillBodyClickIntent({ ...base, isPaused: true })).toBe(
      "resume",
    );
  });

  it("toggles dictation when no session is paused", () => {
    expect(resolvePillBodyClickIntent(base)).toBe("toggle");
  });

  it("ignores clicks outside the main window", () => {
    expect(
      resolvePillBodyClickIntent({
        ...base,
        isMainWindow: false,
        isPaused: true,
      }),
    ).toBe("ignore");
  });

  it("ignores clicks while dictation is stopping or locked", () => {
    expect(
      resolvePillBodyClickIntent({
        ...base,
        isDictationInteractable: false,
        isPaused: true,
      }),
    ).toBe("ignore");
  });
});
