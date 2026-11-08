import type { StopRecordingResponse } from "../types/transcription-session.types";

/**
 * What to tell the user when a recording ended because the capture died.
 *
 * `null` means there is nothing to say: either the capture reported no fault, or
 * the payload did not name one. That second case is not the same as a healthy
 * recording — a stream that goes quiet without telling anyone is invisible here
 * and only shows up in the native log — which is why this only ever speaks when
 * the native side positively reported a fault.
 *
 * The message text lives at the call site rather than here, as a literal, because
 * the i18n extractor only sees `defaultMessage` when it is a string literal in
 * the component. Returning the text from this module made the extractor skip it,
 * and the next `i18n:extract` then pruned it from the catalogue while the app
 * still asked for it — a message that renders as its id.
 */
export type CaptureFaultNotice = {
  /**
   * Which notice to show. `capture_faulted` carries two real figures;
   * `ended_early` is the case where the native side said the stream was gone but
   * the body carried no lengths, so the message must not invent any.
   */
  kind: "capture_faulted" | "ended_early";
  /** The developer-facing line, so the log and the toast agree. */
  logMessage: string;
  /** Substitution values in seconds, to one decimal place. */
  values: { captured: string; expected: string };
};

/**
 * A finite, non-negative millisecond count from a possibly absent number.
 *
 * The body comes from a native command, so a truncated or older payload can
 * carry `undefined`, and a negative figure would be printer's noise rather than
 * information. Both are treated as zero.
 */
const millis = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
};

const seconds = (valueMs: number): string => (valueMs / 1000).toFixed(1);

/**
 * The notice for a stop response, or `null` when nothing needs saying.
 *
 * `expected` is clamped up to `captured`: a body claiming less expected than
 * captured time would read as "stopped after 4.0 of 1.2 seconds", which is
 * nonsense on its face and undermines every other number in the message. The
 * clamp only ever widens to the captured figure, so a wrong value can make the
 * message uninformative but never contradictory.
 *
 * A fault with no lengths at all becomes `ended_early` rather than a message
 * with two zeroes: "stopped after 0.0 of 0.0 seconds" states that nothing was
 * captured, which may be false.
 */
export const captureFaultNotice = (
  audio: Pick<
    StopRecordingResponse,
    "captureFault" | "capturedMs" | "expectedMs"
  >,
): CaptureFaultNotice | null => {
  if (!audio.captureFault) {
    return null;
  }
  const capturedMs = millis(audio.capturedMs);
  const expectedMs = Math.max(capturedMs, millis(audio.expectedMs));
  if (capturedMs === 0 && expectedMs === 0) {
    return {
      kind: "ended_early",
      logMessage: "capture faulted with no length reported",
      values: { captured: "0.0", expected: "0.0" },
    };
  }
  return {
    kind: "capture_faulted",
    logMessage: `capture faulted after ${Math.round(capturedMs)}ms of ${Math.round(
      expectedMs,
    )}ms`,
    values: { captured: seconds(capturedMs), expected: seconds(expectedMs) },
  };
};
