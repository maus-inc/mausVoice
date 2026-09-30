import type { PostProcessMetadata } from "./transcribe.actions";
import { describe, expect, it, vi } from "vitest";

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
    expect(result!.styled.length).toBeGreaterThan(0);
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
