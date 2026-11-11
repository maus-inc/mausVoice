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
 * How much audio must be missing before the two-length message is worth
 * showing, in milliseconds.
 *
 * A late error callback costs at most the buffer that was in flight when the
 * device went away, so anything this small is not audio the user lost. The
 * native side drops such a fault before it reaches the body
 * (`FAULT_GAP_TOLERANCE` in `platform/audio.rs`), and this is the same rule on
 * this side of the boundary: the body is a contract, not a trusted sender, and a
 * stale one must not be able to raise an alarm either.
 */
const MEANINGFUL_GAP_MS = 250;

/**
 * The notice for a stop response, or `null` when nothing needs saying.
 *
 * Four cases, in order:
 *
 * - No fault token: `null`. Nothing was reported, so nothing is claimed.
 * - A fault with no expected length: `ended_early`. The host said the capture
 *   died and the body does not say what it should have contained, so the wording
 *   must not invent a figure.
 * - A fault with an expected length and nothing missing: `null`. The host's error
 *   callback can land after the last block was already delivered, so a `fatal`
 *   token does not prove audio was lost. Telling the user to check a cable for a
 *   whole recording is a false alarm on a working microphone, which costs more
 *   than the report is worth.
 * - Otherwise `capture_faulted`, with both figures.
 *
 * `expected` is clamped up to `captured`: a body claiming less expected than
 * captured time would read as "stopped after 4.0 of 1.2 seconds", which is
 * nonsense on its face and undermines every other number in the message. The
 * clamp only ever widens to the captured figure, so a wrong value can make the
 * message uninformative but never contradictory.
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
  if (millis(audio.expectedMs) === 0) {
    // A fault with no expected length: the loss is unknown, not zero. The
    // wording has to stand without figures, and two zeroes would instead assert
    // that nothing was captured, which may be false.
    return {
      kind: "ended_early",
      logMessage: "capture faulted with no expected length reported",
      values: { captured: seconds(capturedMs), expected: seconds(capturedMs) },
    };
  }
  const expectedMs = Math.max(capturedMs, millis(audio.expectedMs));
  if (expectedMs - capturedMs < MEANINGFUL_GAP_MS) {
    // Nothing a person could notice is missing, so there is nothing to say.
    return null;
  }
  return {
    kind: "capture_faulted",
    logMessage: `capture faulted after ${Math.round(capturedMs)}ms of ${Math.round(
      expectedMs,
    )}ms`,
    values: { captured: seconds(capturedMs), expected: seconds(expectedMs) },
  };
};
