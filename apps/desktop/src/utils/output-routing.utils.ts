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

export const routeTranscriptOutput = async (
  args: RouteTranscriptOutputArgs,
): Promise<RouteTranscriptOutputResult> => {
  const state = getAppState();
  const prefs = getMyUserPreferences(state);
  const currentApp = args.currentAppId
    ? (state.appTargetById[args.currentAppId] ?? null)
    : null;

  if (prefs?.remoteOutputEnabled && prefs.remoteTargetDeviceId) {
    if (!args.text.trim()) {
      return {
        delivered: false,
        remote: true,
      };
    }

    await invoke<void>("remote_sender_deliver_final_text", {
      args: {
        targetDeviceId: prefs.remoteTargetDeviceId,
        text: args.text,
        mode: args.mode,
      },
    });

    return {
      delivered: true,
      remote: true,
    };
  }

  let outputText = args.text;
  if (prefs?.reviewBeforeInsert === true && outputText.trim()) {
    const reviewed = await reviewTextInComposer(outputText);
    if (reviewed === null) {
      return { delivered: false, remote: false };
    }
    outputText = reviewed;
  }

  if (!outputText.trim()) {
    return { delivered: false, remote: false };
  }

  const insertionMethod =
    currentApp?.insertionMethod ?? prefs?.insertionMethod ?? "paste";

  const typingSpeedMs = currentApp?.typingSpeedMs ?? prefs?.typingSpeedMs ?? 5;

  if (insertionMethod === "type") {
    await insertLocalTranscriptOutputViaTyping(outputText, typingSpeedMs);
  } else {
    const pasteKeybind =
      state.supportsPasteKeybinds === "global"
        ? (prefs?.pasteKeybind ?? null)
        : (currentApp?.pasteKeybind ?? prefs?.pasteKeybind ?? null);

    await insertLocalTranscriptOutputViaPaste(outputText, pasteKeybind);
  }

  return {
    delivered: true,
    remote: false,
  };
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
