import { invoke } from "@tauri-apps/api/core";
import type {
  RouteTranscriptOutputArgs,
  RouteTranscriptOutputResult,
} from "@maus-inc/types";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { reviewTextInComposer } from "./composer.utils";
import { getLogger } from "./log.utils";
import { sendPillFlashMessage } from "./overlay.utils";
import { sanitizeIndentation } from "./string.utils";
import { getMyUserPreferences } from "./user.utils";

type PasteOutcome = "pasted" | "copied_to_clipboard";

type OutputContext = {
  state: ReturnType<typeof getAppState>;
  prefs: ReturnType<typeof getMyUserPreferences>;
  currentApp: ReturnType<typeof getAppState>["appTargetById"][string] | null;
};

const getOutputContext = (args: RouteTranscriptOutputArgs): OutputContext => {
  const state = getAppState();
  return {
    state,
    prefs: getMyUserPreferences(state),
    currentApp: args.currentAppId
      ? (state.appTargetById[args.currentAppId] ?? null)
      : null,
  };
};

const deliverRemoteOutput = async (
  args: RouteTranscriptOutputArgs,
  prefs: NonNullable<OutputContext["prefs"]>,
): Promise<RouteTranscriptOutputResult> => {
  if (!args.text.trim()) return { delivered: false, remote: true };
  await invoke<void>("remote_sender_deliver_final_text", {
    args: {
      targetDeviceId: prefs.remoteTargetDeviceId,
      text: args.text,
      mode: args.mode,
    },
  });
  return { delivered: true, remote: true };
};

const reviewOutputText = async (
  text: string,
  prefs: OutputContext["prefs"],
  skipReview?: boolean,
): Promise<string | null> => {
  if (skipReview || prefs?.reviewBeforeInsert !== true || !text.trim()) {
    return text;
  }
  return reviewTextInComposer(text);
};

const insertLocalOutput = async (
  context: OutputContext,
  text: string,
  suppressFlashOnClipboard = false,
): Promise<PasteOutcome | undefined> => {
  const insertionMethod =
    context.currentApp?.insertionMethod ??
    context.prefs?.insertionMethod ??
    "paste";
  if (insertionMethod === "type") {
    const typingSpeedMs =
      context.currentApp?.typingSpeedMs ?? context.prefs?.typingSpeedMs ?? 5;
    await insertLocalTranscriptOutputViaTyping(text, typingSpeedMs);
    return undefined;
  }

  const pasteKeybind =
    context.state.supportsPasteKeybinds === "global"
      ? (context.prefs?.pasteKeybind ?? null)
      : (context.currentApp?.pasteKeybind ??
        context.prefs?.pasteKeybind ??
        null);
  return insertLocalTranscriptOutputViaPaste(
    text,
    pasteKeybind,
    suppressFlashOnClipboard,
  );
};

export const routeTranscriptOutput = async (
  args: RouteTranscriptOutputArgs,
): Promise<RouteTranscriptOutputResult> => {
  const context = getOutputContext(args);
  const { prefs } = context;

  if (prefs?.remoteOutputEnabled && prefs.remoteTargetDeviceId) {
    return deliverRemoteOutput(args, prefs);
  }

  const outputText = await reviewOutputText(args.text, prefs, args.skipReview);
  if (!outputText?.trim()) return { delivered: false, remote: false };

  await insertLocalOutput(context, outputText);
  return { delivered: true, remote: false };
};

export const insertLocalTranscriptOutputViaPaste = async (
  text: string,
  keybind: string | null,
  suppressClipboardFlash = false,
): Promise<PasteOutcome> => {
  const sanitized = sanitizeIndentation(text);

  const outcome = await invoke<PasteOutcome>("paste", {
    text: sanitized,
    keybind,
  });

  if (outcome === "copied_to_clipboard") {
    getLogger().info(
      "Focused element was not editable, transcription copied to clipboard",
    );
    if (!suppressClipboardFlash) {
      sendPillFlashMessage(
        getIntl().formatMessage({
          defaultMessage: "Transcript copied to clipboard",
        }),
      );
    }
  }

  return outcome;
};

export const insertLocalTranscriptOutputViaTyping = async (
  text: string,
  delayMs: number,
): Promise<void> => {
  const sanitized = sanitizeIndentation(text);

  // ReentryGuard serializes simulate_type, so cancel_typing always
  // targets the one live session — no session id is needed.
  const handleCancel = () => {
    // Fire-and-forget, but never unhandled: a failed cancel must not raise
    // an unhandled rejection on every blur/Escape.
    void invoke("cancel_typing").catch((error: unknown) => {
      getLogger().warning(`Failed to cancel simulated typing: ${error}`);
    });
  };

  window.addEventListener("blur", handleCancel, { once: true });
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    }
  };
  window.addEventListener("keydown", keydownHandler);

  try {
    await invoke("simulate_type", {
      text: sanitized,
      delayMs,
    });
  } finally {
    window.removeEventListener("blur", handleCancel);
    window.removeEventListener("keydown", keydownHandler);
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Dictation backlog state management
// ──────────────────────────────────────────────────────────────────────────────

/** Return a snapshot of the current dictation backlog. */
export const getDictationBacklog = (): string[] => {
  return getAppState().dictationBacklog;
};

/** True when the backlog is non-empty. */
export const hasDictationBacklog = (): boolean => {
  return getAppState().dictationBacklog.length > 0;
};

/** Append a segment to the backlog. No side effects. */
export const appendToDictationBacklog = (text: string): void => {
  produceAppState((draft) => {
    draft.dictationBacklog.push(text);
  });
};

/** Clear the backlog (call at session start). */
export const clearDictationBacklog = (): void => {
  produceAppState((draft) => {
    draft.dictationBacklog = [];
  });
};

/**
 * Increment the session nonce so stale backlog data from a previous
 * session is identifiable.
 */
export const incrementDictationBacklogNonce = (): void => {
  produceAppState((draft) => {
    draft.dictationBacklogNonce += 1;
  });
};

/**
 * Snapshot of backlog + session nonce. Consumers compare the nonce against
 * the current value before acting on old data (e.g. a queued drain that
 * completed after a new session started).
 */
type BacklogSnapshot = { segments: string[]; nonce: number };

const takeBacklogSnapshot = (): BacklogSnapshot => {
  const { dictationBacklog, dictationBacklogNonce } = getAppState();
  return { segments: [...dictationBacklog], nonce: dictationBacklogNonce };
};

/**
 * Drain the dictation backlog (and optionally a newSegment) into the
 * currently focused field via the standard paste pipeline.
 *
 * - If an editable target is focused: paste and return
 *   `{ delivered: true, copiedToClipboard: false }`.
 * - If NOT editable: single clipboard write + single pill flash, return
 *   `{ delivered: true, copiedToClipboard: true }`.
 * - Empty backlog + no newSegment → return
 *   `{ delivered: false, copiedToClipboard: false }`.
 *
 * The backlog is CLEARED on successful delivery. If the drain fails, the
 * backlog is preserved so the user doesn't lose text.
 */
export const drainDictationBacklog = async (
  newSegment?: string,
): Promise<{ delivered: boolean; copiedToClipboard: boolean }> => {
  const snap = takeBacklogSnapshot();
  if (snap.segments.length === 0 && !newSegment?.trim()) {
    return { delivered: false, copiedToClipboard: false };
  }

  // Build the combined text: backlog segments joined with spaces, then the
  // new segment. The trailing space from each backlog segment's storage
  // is normalized by the join.
  const segments = [...snap.segments];
  if (newSegment?.trim()) {
    segments.push(newSegment.trim());
  }
  const combinedText = segments.join(" ");

  // Deliver the combined backlog text through the standard output path so
  // app- and user-specific insertion methods and paste keybinds are
  // respected. suppressFlashOnClipboard=false so the ONE permitted pill
  // flash happens when the backlog hits a non-editable target.
  const state = getAppState();
  const context: OutputContext = {
    state,
    prefs: getMyUserPreferences(state),
    currentApp: null,
  };
  const pasteOutcome = await insertLocalOutput(context, combinedText, false);

  // Snapshot after paste to confirm we're still in the same session.
  const currentNonce = getAppState().dictationBacklogNonce;
  if (currentNonce !== snap.nonce) {
    // A new session started — don't clear backlog from a prior session.
    return { delivered: true, copiedToClipboard: pasteOutcome === "copied_to_clipboard" };
  }

  // Clear the backlog on successful delivery.
  clearDictationBacklog();

  return {
    delivered: true,
    copiedToClipboard: pasteOutcome === "copied_to_clipboard",
  };
};