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
 * The post-recording windows the settings offer, shortest first.
 *
 * This exists because the switch alone could only ever set one window, while
 * the tokens above documented a 30 s ceiling nothing could reach -- a control
 * that promised a range and exposed a constant. Three choices, because the
 * meaningful distinction for a user is "barely a beat" against "the same
 * thought" against "stop and think"; anything finer is a slider, and a slider
 * for a value a user sets once and forgets is worse than three buttons.
 *
 * The values are the ones the backend's finite-window test already covers
 * (1 ms ... 30 s), and every one of them keeps the microphone indicator lit for
 * exactly that long after a recording, which is what the copy has to say.
 */
export const MICROPHONE_LINGER_CHOICES_MS = [3_000, 5_000, 15_000] as const;

/**
 * The windows offered while the preference is in the state it is in.
 *
 * Zero is not one of the choices. "Close at stop" is the switch being off, and
 * offering it as a fourth button would give one state two controls that can
 * disagree -- the same reason the keep-ready switch disables this one instead
 * of showing a second copy of its value.
 */
export const lingerChoices = (): readonly number[] =>
  MICROPHONE_LINGER_CHOICES_MS;

/**
 * The nearest offered window to an arbitrary stored value.
 *
 * A profile can hold a value from an older build or a hand-edited database, and
 * the segmented control can only display one of its own options. Rather than
 * showing no selection, the closest offered window is selected -- but the value
 * is *not* written back on read, because opening a settings dialog must not
 * change a preference. The write happens when the user picks one.
 */
export const nearestLingerChoice = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_MICROPHONE_LINGER_MS;
  }
  return MICROPHONE_LINGER_CHOICES_MS.reduce((best, choice) =>
    Math.abs(choice - value) < Math.abs(best - value) ? choice : best,
  );
};

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
 * Device-name fragments that identify a Bluetooth headset.
 *
 * A superset of the backend's `LOW_QUALITY_INPUT_KEYWORDS`, and for a different
 * question. The backend uses its list to *rank* devices, so a miss costs a
 * worse-sounding press. This one decides whether to warn the user that holding
 * the device costs them audio quality, so a miss leaves a real cost unstated.
 * The extra entries are the transport words a headset can appear under rather
 * than the headset brands themselves.
 */
const BLUETOOTH_DEVICE_MARKERS = [
  "airpods",
  "beats",
  "bluetooth",
  "earbud",
  "hands-free",
  "hands free",
  "hfp",
  "hsp",
  "headset",
  "sony wh-",
  "wireless",
] as const;

/**
 * Whether the device identified by this label rides on Bluetooth.
 *
 * Holding a Bluetooth microphone open is not the same trade as holding the
 * built-in one. The link is a shared, half-duplex channel: while an application
 * captures, macOS moves the headset from A2DP to the hands-free profile, so
 * music and calls drop to call quality and the headset's battery drains faster
 * for as long as the hold lasts. None of that is visible as a microphone
 * indicator, which is all the existing copy promised. A name is the only signal
 * the device list carries -- `InputDeviceDescriptor` has no transport field --
 * so this is a heuristic, and it is used only to *add* a warning, never to
 * change what the app does.
 */
export const isLikelyBluetoothDevice = (
  label: string | null | undefined,
): boolean => {
  if (typeof label !== "string" || label.length === 0) {
    return false;
  }
  const lower = label.toLowerCase();
  return BLUETOOTH_DEVICE_MARKERS.some((marker) => lower.includes(marker));
};

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
  // AUDCLNT_E_DEVICE_IN_USE. Not 0x88890004, which is one digit away and is
  // AUDCLNT_E_DEVICE_INVALIDATED: a device that vanished, not one another
  // application is holding. This list mirrors the Rust one.
  "0x8889000a",
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
  // `String(value ?? "")` would stringify `null` as the empty string but every
  // other non-message as `"[object Object]"`, which then gets searched for
  // device markers and can only ever miss. Anything that is not a string is
  // treated as no message at all.
  const text = typeof message === "string" ? message : "";
  const haystack = text.toLowerCase();
  if (containsAny(haystack, PERMISSION_MARKERS)) return "permission_denied";
  if (containsAny(haystack, IN_USE_MARKERS))
    return "in_use_by_another_application";
  if (containsAny(haystack, UNAVAILABLE_MARKERS)) return "unavailable";
  return "unknown";
};
