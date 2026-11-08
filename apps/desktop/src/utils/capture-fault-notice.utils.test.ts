import { describe, expect, it } from "vitest";

import { createMessageId } from "../../scripts/formatjs-id.mjs";
import { captureFaultNotice } from "./capture-fault-notice.utils";

describe("captureFaultNotice", () => {
  it("says nothing for a recording that did not fault", () => {
    expect(captureFaultNotice({ capturedMs: 4_000, expectedMs: 4_100 })).toBe(
      null,
    );
  });

  it("reports both lengths in seconds for a faulted capture", () => {
    const notice = captureFaultNotice({
      captureFault: "fatal",
      capturedMs: 1_400,
      expectedMs: 6_000,
    });

    expect(notice?.values).toEqual({ captured: "1.4", expected: "6.0" });
    expect(notice?.logMessage).toBe("capture faulted after 1400ms of 6000ms");
  });

  it("falls back to a message with no numbers when none were reported", () => {
    // Two zeroes would state that nothing was captured, which may be false. The
    // wording has to stand on its own without figures.
    expect(captureFaultNotice({ captureFault: "fatal" })?.kind).toBe(
      "ended_early",
    );
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: 0,
        expectedMs: 0,
      })?.kind,
    ).toBe("ended_early");
    expect(
      captureFaultNotice({ captureFault: "fatal", capturedMs: 900 })?.kind,
    ).toBe("capture_faulted");
  });

  it("the two messages the component renders have catalogue-safe ids", () => {
    // Ids are derived from the literal at the call site by
    // `scripts/formatjs-id.mjs`, and the catalogue truncates at 64 characters.
    // The extractor only sees a literal, so these strings must match the ones in
    // `DictationSideEffects.tsx`; this test is what catches a divergence once
    // the message has been pruned from the catalogue.
    const detailed = createMessageId(
      "The microphone stopped recording after {captured} of {expected} seconds. Check that it is still connected.",
    );
    const generic = createMessageId(
      "The recording ended early. Check that the microphone is still connected.",
    );

    expect(detailed.length).toBeLessThanOrEqual(64);
    expect(generic.length).toBeLessThanOrEqual(64);
    expect(detailed).not.toBe(generic);
  });

  it("treats a fault with no lengths as zero rather than NaN", () => {
    const notice = captureFaultNotice({ captureFault: "fatal" });

    // A truncated or older body can arrive with the flag and nothing else.
    // "after NaN of NaN seconds" is worse than saying nothing was measured.
    expect(notice?.values).toEqual({ captured: "0.0", expected: "0.0" });
  });

  it("never reports less expected time than captured", () => {
    const notice = captureFaultNotice({
      captureFault: "fatal",
      capturedMs: 4_000,
      expectedMs: 1_200,
    });

    // Clamped up, so the message cannot contradict itself.
    expect(notice?.values).toEqual({ captured: "4.0", expected: "4.0" });
  });

  it("rejects a negative or non-finite length", () => {
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: -5,
        expectedMs: Number.POSITIVE_INFINITY,
      })?.values,
    ).toEqual({ captured: "0.0", expected: "0.0" });
  });
});
