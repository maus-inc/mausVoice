/**
 * Rules for holding the microphone open between dictations.
 *
 * Opening a capture device is the whole delay between a press and the first
 * captured sample. Measured cold starts on the same hardware run from about
 * 400 ms to several seconds, and a held-open device brings the same press down
 * to a few tens of milliseconds. The trade is that the operating system shows
 * its microphone-in-use indicator for as long as the device is held, so this is
 * opt-in and the copy that offers it has to say so.
 */

/** The longest pre-roll the recorder accepts, in seconds. Mirrors the Rust cap. */
export const MAX_MICROPHONE_PREROLL_SECONDS = 2;

/**
 * Default pre-roll. Half a second covers a press that lands after the user has
 * started speaking, without pulling in audio from a previous thought.
 */
export const DEFAULT_MICROPHONE_PREROLL_SECONDS = 0.5;

/**
 * The longest linger window the settings offer, in milliseconds.
 *
 * A second press within this window skips the device open entirely. Beyond a few
 * seconds the window stops covering the case it exists for (a user resuming the
 * same thought) and only extends the microphone indicator for no benefit.
 */
export const MAX_MICROPHONE_LINGER_MS = 30_000;

/** The linger the settings offer as the "a few seconds" choice. */
export const DEFAULT_MICROPHONE_LINGER_MS = 5_000;

/**
 * The linger value that means "hold until released".
 *
 * The backend reads a hold at or above this magnitude as the sentinel for "no
 * timer". Sending a plausible few seconds instead would make an always-ready
 * microphone close itself while the preference says it is on.
 */
export const MICROPHONE_READY_FOREVER_MS = Number.MAX_SAFE_INTEGER;

/**
 * Clamps a requested pre-roll into the window the recorder accepts.
 *
 * A stored value can be missing, because the preference postdates the profile,
 * or nonsense from a hand-edited database. Both land on the default, so no call
 * site has to repeat that decision.
 */
export const normalizeMicrophonePrerollSeconds = (
  value: number | null | undefined,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MICROPHONE_PREROLL_SECONDS;
  }
  return Math.min(MAX_MICROPHONE_PREROLL_SECONDS, Math.max(0, value));
};

/**
 * Clamps a requested linger into the window the settings offer.
 *
 * Zero is kept as zero: closing at stop is a real choice and the default, not a
 * missing value.
 */
export const normalizeMicrophoneLingerMs = (
  value: number | null | undefined,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_MICROPHONE_LINGER_MS, Math.round(value));
};

/**
 * Whether the app should *open* a capture stream right now.
 *
 * This answers "is there a stream to open?", not "should an existing stream be
 * closed?" -- the two are not complements. `isRecording` is here so no second
 * stream is opened while one is recording, not so a held stream is released
 * when a recording starts: the press adopts the held stream, and releasing it
 * would close the very device the recording is using. The caller returns early
 * on a recording rather than reading a `false` here as an instruction to let go.
 *
 * A warm stream is only useful while local data is not being cleared: a clear is
 * about to delete what was captured, and holding a device open through it would
 * keep a microphone live for audio that is on its way out.
 */
export const shouldHoldMicrophoneReady = ({
  enabled,
  isRecording,
  isLocalDataClearing,
  permissionGranted,
}: {
  enabled: boolean;
  isRecording: boolean;
  isLocalDataClearing: boolean;
  /**
   * False when the OS has refused or not yet answered the microphone request.
   * Asking the backend to hold a device it cannot open would surface an error
   * for a preference the user already set, so the hold waits for permission.
   */
  permissionGranted: boolean;
}): boolean =>
  enabled && !isRecording && !isLocalDataClearing && permissionGranted;

/**
 * Whether the app should resolve the next press's device now.
 *
 * This is the cheap half of readiness: it does the device enumeration and
 * scoring ahead of the press, with no capture stream and so no microphone
 * indicator. It runs when the device is not being held, so a press after a
 * release still skips the scoring, and it costs nothing visible.
 */
export const shouldPrepareMicrophone = ({
  isRecording,
  isLocalDataClearing,
  permissionGranted,
  holdActive,
}: {
  isRecording: boolean;
  isLocalDataClearing: boolean;
  permissionGranted: boolean;
  /**
   * True when a capture stream is already held. The hold resolved the device
   * when it opened, so preparing again would only repeat that work.
   */
  holdActive: boolean;
}): boolean =>
  !isRecording && !isLocalDataClearing && permissionGranted && !holdActive;

/**
 * Whether the in-use caption should say the device is held right now.
 *
 * `microphoneHeld` is what the backend reports, not what the preference asks
 * for, and `null` means it has not been read yet. Showing a claim either way
 * before the first read would tell the user something the app does not know.
 */
export const describeHeldState = (
  held: boolean | null,
): "unknown" | "held" | "not_held" => {
  if (held === null) return "unknown";
  return held ? "held" : "not_held";
};

/**
 * Why an open attempt failed, as far as the message says.
 *
 * The backend classifies the same text in Rust; this exists because the
 * message the UI receives has already been narrowed to a string, and the
 * guidance shown to the user depends on which failure it was. Keeping the two
 * in step is a contract: `MICROPHONE_FAILURE_MARKERS` mirrors the marker lists
 * in `src-tauri/src/platform/mic_usage.rs`, and a test here asserts the pairs
 * that matter rather than trusting them to stay equal by inspection.
 */
export type MicrophoneOpenFailure =
  | "in_use_by_another_application"
  | "permission_denied"
  | "unavailable"
  | "unknown";

const IN_USE_MARKERS = [
  "device or resource busy",
  "no available subdevice",
  "0x88890004",
  "audclnt_e_device_in_use",
  "in use by another",
  "kaudiouniterr_deviceinuse",
  "device is in use",
];

const PERMISSION_MARKERS = [
  "0x80070005",
  "access is denied",
  "access denied",
  "permission denied",
  "eperm",
  "not authorized",
  "unauthorized",
  "permission",
  "operation not permitted",
];

const UNAVAILABLE_MARKERS = [
  "no longer available",
  "not available",
  "no input device",
  "no such device",
  "not found",
  "unplugged",
  "disconnected",
  "invalidated",
];

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

/**
 * Classifies a failed open from its message.
 *
 * The order is the same as the Rust side and for the same reason: permission
 * before in-use, in-use before unavailable. Windows' access-denied text, ALSA's
 * busy message and cpal's unplugged message all mention a device, and telling
 * the user to close an application that is not running sends them looking for
 * something that is not there.
 */
export const classifyMicrophoneFailure = (
  message: unknown,
): MicrophoneOpenFailure => {
  const text = typeof message === "string" ? message : String(message ?? "");
  const haystack = text.toLowerCase();
  if (containsAny(haystack, PERMISSION_MARKERS)) return "permission_denied";
  if (containsAny(haystack, IN_USE_MARKERS))
    return "in_use_by_another_application";
  if (containsAny(haystack, UNAVAILABLE_MARKERS)) return "unavailable";
  return "unknown";
};
