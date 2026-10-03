import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { PostProcessMetadata } from "./transcribe.actions";
import { FAST_STYLE_MAX_INPUT_CHARS } from "../utils/fast-style.utils";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

// Imported after the mock so the module picks up the stubbed logger.
const { applyFastLocalStyle } = await import("./transcribe.actions");

const run = (rawTranscript: string, toneId: string) => {
  const metadata: PostProcessMetadata = {};
  const warnings: string[] = [];
  const result = applyFastLocalStyle({
    rawTranscript,
    toneId,
    metadata,
    warnings,
    reason: "no-llm",
  });
  return { result, metadata, warnings };
};

describe("applyFastLocalStyle", () => {
  // Regression: the filler, informal and contraction passes are subtractive, so
  // filler-only input came back empty. Both call sites returned that empty
  // string verbatim, and `dictation.strategy` gates insertion on a truthy
  // transcript while `postProcessFailed` stayed false — the dictation vanished
  // with nothing inserted and nothing reported.
  it.each(["default", "formal", "concise", "notes"])(
    "returns null when tone %s strips the whole transcript",
    (toneId) => {
      const { result } = run("um uh er", toneId);
      expect(result).toBeNull();
    },
  );

  it("still returns styled output when the transform produces text", () => {
    const { result } = run(
      "um so basically we shipped the release today",
      "concise",
    );
    expect(result).not.toBeNull();
    // `expect(...).not.toBeNull()` above is the guard, but it does not narrow
    // the type, so state the invariant explicitly instead of asserting it.
    if (result === null) throw new Error("expected a styled result");
    expect(result.styled.length).toBeGreaterThan(0);
  });

  it("reports the fast mode in metadata when it does apply", () => {
    const { result, metadata } = run(
      "um so basically we shipped the release today",
      "concise",
    );
    expect(result).not.toBeNull();
    expect(metadata.postProcessMode).toBe("fast");
  });

  it("does not claim the fast mode when it bailed out", () => {
    const { result, metadata } = run("um uh er", "concise");
    expect(result).toBeNull();
    expect(metadata.postProcessMode).toBeUndefined();
  });
});

// The dropped tail is only recoverable when the transcript is actually written
// somewhere. `isPersistenceAllowed()` is false under incognito mode and during
// an ephemeral session, and both store paths honour it, so the warning used to
// promise a History row that no code path created.
describe("fast style truncation warning", () => {
  const OVER_CAP = "dictation word ".repeat(2000);
  const DROPPED = OVER_CAP.trim().length - FAST_STYLE_MAX_INPUT_CHARS;

  const warn = (mutate: (state: typeof INITIAL_APP_STATE) => void) => {
    const state = structuredClone(INITIAL_APP_STATE);
    mutate(state);
    setAppState(state, true);
    const { warnings } = run(OVER_CAP, "concise");
    expect(warnings).toHaveLength(1);
    return warnings[0];
  };

  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("points at History for a transcript that was persisted", () => {
    // No state mutation: this case is about the default (persisted) path.
    const message = warn(() => undefined);
    expect(message).toContain(String(DROPPED));
    expect(message).toContain("History");
  });

  it.each([
    // `userPrefs` starts as null and `isIncognitoModeEnabled` reads through it
    // with `?.`, so the object has to exist before the flag can be set.
    [
      "incognito mode",
      (s: typeof INITIAL_APP_STATE) => {
        s.userPrefs = { incognitoModeEnabled: true } as typeof s.userPrefs;
      },
    ],
    [
      "an ephemeral session",
      (s: typeof INITIAL_APP_STATE) => {
        s.local.ephemeralSessionActive = true;
      },
    ],
  ])("does not promise History under %s", (_label, mutate) => {
    const message = warn(mutate);
    // The count is still true and still actionable, so it stays.
    expect(message).toContain(String(DROPPED));
    // The defect is the promise, not the word "History": nothing was written,
    // so the message must deny the tail is recoverable rather than send the
    // user looking for a row that was never created.
    expect(message).not.toContain("saved in History");
    expect(message).toMatch(/not saved/i);
  });
});
