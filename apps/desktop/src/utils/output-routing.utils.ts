import { invoke } from "@tauri-apps/api/core";
import type {
  RouteTranscriptOutputArgs,
  RouteTranscriptOutputResult,
} from "@maus-inc/types";
import { beginEditWatch } from "../actions/edit-watch.actions";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { getEffectiveHandsFreeDelayMs } from "./hands-free-delay.utils";
import { reviewTextInComposer } from "./composer.utils";
import { getLogger } from "./log.utils";
import { sendPillFlashMessage } from "./overlay.utils";
import { sanitizeIndentation } from "./string.utils";
import { getMyUserPreferences } from "./user.utils";

type PasteOutcome = "pasted" | "copied_to_clipboard";

let handsFreeSessionId = 0;

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
  // NOTE: the pill intentionally keeps its processing phase while this
  // review is open. The review await sits inside the caller's
  // handleTranscript chain, which also gates `isStoppingRef`, so
  // advertising an idle pill here would promise interactions the flow
  // cannot honor yet — and the wrapper's timeout must stay larger than
  // the composer's own decision window so a long read can never be
  // misclassified as a hang and skip history persistence. True phase
  // decoupling needs the review wait lifted out of stopRecording and is
  // tracked as a follow-up.
  return reviewTextInComposer(text);
};

const insertLocalOutput = async (
  context: OutputContext,
  text: string,
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
  return insertLocalTranscriptOutputViaPaste(text, pasteKeybind);
};

export const routeTranscriptOutput = async (
  args: RouteTranscriptOutputArgs,
): Promise<RouteTranscriptOutputResult> => {
  const context = getOutputContext(args);
  const { prefs } = context;
  const sessionId = ++handsFreeSessionId;

  if (prefs?.remoteOutputEnabled && prefs.remoteTargetDeviceId) {
    const outputText = await reviewOutputText(
      args.text,
      prefs,
      args.skipReview,
    );
    if (!outputText?.trim()) return { delivered: false, remote: true };
    return deliverRemoteOutput({ ...args, text: outputText }, prefs);
  }

  const outputText = await reviewOutputText(args.text, prefs, args.skipReview);
  if (!outputText?.trim()) return { delivered: false, remote: false };

  const handsFreeDelayMs = getEffectiveHandsFreeDelayMs(prefs);

  if (handsFreeDelayMs > 0 && !args.isInterim) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, handsFreeDelayMs);
    });
    if (sessionId !== handsFreeSessionId) {
      return { delivered: false, remote: false };
    }
  }

  await insertLocalOutput(context, outputText);

  // After a final dictation lands in the target app, watch for corrections
  // the user makes there and offer to learn them. Interim streamed segments
  // are excluded: there is no single "final" paste to diff against.
  if (!args.isInterim && args.mode === "dictation") {
    beginEditWatch(outputText);
  }

  return { delivered: true, remote: false };
};

export const insertLocalTranscriptOutputViaPaste = async (
  text: string,
  keybind: string | null,
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
    sendPillFlashMessage(
      getIntl().formatMessage({
        defaultMessage: "Transcript copied to clipboard",
      }),
    );
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
  return [...getAppState().dictationBacklog];
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
 *
 * @param newSegment  Optional additional segment to deliver with the backlog.
 * @param currentAppId  Optional app target id for resolving app-specific
 *                      insertion method and paste keybind preferences.
 */
export const drainDictationBacklog = async (
  newSegment?: string,
  currentAppId?: string | null,
): Promise<{ delivered: boolean; copiedToClipboard: boolean }> => {
  const snap = takeBacklogSnapshot();
  if (snap.segments.length === 0 && !newSegment?.trim()) {
    return { delivered: false, copiedToClipboard: false };
  }

  // Build the combined text: backlog segments joined with spaces (same
  // separator used by the live path when it accumulates streamedText).
  // Then apply the same trailing-space/newline logic as handleInterimSegment
  // so the backlog text behaves identically to live segments.
  const segments = [...snap.segments];
  if (newSegment?.trim()) {
    segments.push(newSegment.trim());
  }
  const raw = segments.join(" ");
  const combinedText = raw.endsWith("\n") ? raw : `${raw} `;

  // Check nonce BEFORE delivery — if the session already advanced, this
  // backlog belongs to a prior session and must not be delivered.
  if (getAppState().dictationBacklogNonce !== snap.nonce) {
    return { delivered: false, copiedToClipboard: false };
  }

  // Deliver the combined backlog text through the standard output path so
  // app- and user-specific insertion methods and paste keybinds are
  // respected.
  const state = getAppState();
  const context: OutputContext = {
    state,
    prefs: getMyUserPreferences(state),
    currentApp: currentAppId
      ? (state.appTargetById[currentAppId] ?? null)
      : null,
  };
  const pasteOutcome = await insertLocalOutput(context, combinedText);

  // Post-delivery nonce check: session may have advanced during the
  // async deliver call.
  if (getAppState().dictationBacklogNonce !== snap.nonce) {
    return {
      delivered: true,
      copiedToClipboard: pasteOutcome === "copied_to_clipboard",
    };
  }

  // Clear the backlog on successful delivery.
  clearDictationBacklog();

  return {
    delivered: true,
    copiedToClipboard: pasteOutcome === "copied_to_clipboard",
  };
};
