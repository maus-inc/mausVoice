import { invoke } from "@tauri-apps/api/core";
import type {
  RouteTranscriptOutputArgs,
  RouteTranscriptOutputResult,
} from "@maus-inc/types";
import { getIntl } from "../i18n/intl";
import { getAppState } from "../store";
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
): Promise<void> => {
  const insertionMethod =
    context.currentApp?.insertionMethod ??
    context.prefs?.insertionMethod ??
    "paste";
  if (insertionMethod === "type") {
    const typingSpeedMs =
      context.currentApp?.typingSpeedMs ?? context.prefs?.typingSpeedMs ?? 5;
    await insertLocalTranscriptOutputViaTyping(text, typingSpeedMs);
    return;
  }

  const pasteKeybind =
    context.state.supportsPasteKeybinds === "global"
      ? (context.prefs?.pasteKeybind ?? null)
      : (context.currentApp?.pasteKeybind ??
        context.prefs?.pasteKeybind ??
        null);
  await insertLocalTranscriptOutputViaPaste(text, pasteKeybind);
};

export const routeTranscriptOutput = async (
  args: RouteTranscriptOutputArgs,
): Promise<RouteTranscriptOutputResult> => {
  const context = getOutputContext(args);
  const { prefs } = context;

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

  await insertLocalOutput(context, outputText);
  return { delivered: true, remote: false };
};

export const insertLocalTranscriptOutputViaPaste = async (
  text: string,
  keybind: string | null,
): Promise<void> => {
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
