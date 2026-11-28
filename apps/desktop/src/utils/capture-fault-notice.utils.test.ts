import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("does not claim a loss when the whole recording was delivered", () => {
    // The host's error callback can land after the last block, so a fatal token
    // with equal lengths means the recording is complete. "Stopped after 6.0 of
    // 6.0 seconds" would contradict itself and send the user to check a cable
    // for an intact dictation.
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: 6_000,
        expectedMs: 6_000,
      }),
    ).toBeNull();
    // Rounding to a tenth of a second hides anything under this.
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: 6_000,
        expectedMs: 6_049,
      }),
    ).toBeNull();
    // A visible gap keeps the two figures.
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: 6_000,
        expectedMs: 6_300,
      })?.kind,
    ).toBe("capture_faulted");
    // And a big loss late in a long dictation is still a loss. A proportional
    // suspicion test would have hidden this: five seconds out of sixty is under
    // a tenth, and it is exactly the case worth telling the user about.
    expect(
      captureFaultNotice({
        captureFault: "fatal",
        capturedMs: 55_000,
        expectedMs: 60_000,
      })?.values,
    ).toEqual({ captured: "55.0", expected: "60.0" });
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
    // A lone captured length cannot show a gap, so it gets the generic wording
    // rather than the detailed one, which needs a second figure. This assertion
    // used to expect the detailed message, which was the contradiction itself.
    expect(
      captureFaultNotice({ captureFault: "fatal", capturedMs: 900 })?.kind,
    ).toBe("ended_early");
    expect(
      captureFaultNotice({ captureFault: "fatal", capturedMs: 900 })?.values,
    ).toEqual({ captured: "0.9", expected: "0.9" });
  });

  it("the two messages the component renders have catalogue-safe ids", () => {
    // Read out of the component, not re-typed here. Ids are derived from the
    // literal at the call site by `scripts/formatjs-id.mjs` and the catalogue
    // truncates at 64 characters, so what needs checking is the string the
    // component actually passes. A copy of it in this file only proves the copy
    // matches the extractor: edit the component and the test kept passing on a
    // literal that no longer existed anywhere, which is the drift its own
    // comment claimed to catch.
    const source = readFileSync(
      join(__dirname, "../components/root/DictationSideEffects.tsx"),
      "utf8",
    );
    const callSiteMessages = [
      ...source.matchAll(/defaultMessage:\s*\n?\s*"([^"]{40,})"/g),
    ]
      .map((match) => match[1])
      .filter((message) => message.includes("connected"));

    expect(callSiteMessages).toHaveLength(2);

    const [detailed, generic] = callSiteMessages.map((message) =>
      createMessageId(message),
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
    // An expected figure below the captured one is nonsense, and every path that
    // still produces a notice has to clamp it rather than print "1.2 of 4.0".
    const notice = captureFaultNotice({
      captureFault: "fatal",
      capturedMs: 4_000,
      expectedMs: 1_200,
    });

    // Nothing is missing, so there is no notice to contradict itself.
    expect(notice).toBeNull();

    // The generic path still reports both figures, and clamps there.
    expect(
      captureFaultNotice({ captureFault: "fatal", capturedMs: 4_000 })?.values,
    ).toEqual({ captured: "4.0", expected: "4.0" });
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
