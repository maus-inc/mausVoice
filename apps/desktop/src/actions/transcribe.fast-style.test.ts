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

// An over-cap dictation used to be sliced to `FAST_STYLE_MAX_INPUT_CHARS`, so
// these cases asserted a dropped-character count and a warning whose wording
// depended on whether History was writable. `applyFastStyle` now styles the whole
// input across as many chunks as it takes, so nothing is dropped and there is no
// count to report and no warning to word. These assert that directly, including
// under the states that used to change the message, because "warns about a loss
// that did not happen" is the defect in both directions.
describe("fast style over the chunk size", () => {
  const TAIL = "zztaillowzz";
  const OVER_CAP = `${"dictation word ".repeat(2000)} ${TAIL}.`;

  const style = (mutate: (state: typeof INITIAL_APP_STATE) => void) => {
    const state = structuredClone(INITIAL_APP_STATE);
    mutate(state);
    setAppState(state, true);
    return run(OVER_CAP, "concise");
  };

  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("styles the whole dictation and warns about nothing", () => {
    expect(OVER_CAP.length).toBeGreaterThan(FAST_STYLE_MAX_INPUT_CHARS);
    const { result, metadata, warnings } = style(() => undefined);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a styled result");
    // The tail past the cap survives, which is what used to be lost.
    expect(result.styled.toLowerCase()).toContain(TAIL);
    expect(metadata.fastStyleTruncatedChars).toBeUndefined();
    expect(warnings).toHaveLength(0);
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
  ])("still drops nothing under %s", (_label, mutate) => {
    // These two states used to switch the warning's wording, which only made
    // sense because a tail had been discarded. They must not reintroduce a claim
    // that text was lost.
    const { result, warnings } = style(mutate);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a styled result");
    expect(result.styled.toLowerCase()).toContain(TAIL);
    expect(warnings).toHaveLength(0);
    expect(warnings.join(" ")).not.toMatch(/left unstyled|not saved/i);
  });
});
