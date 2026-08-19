import { invoke } from "@tauri-apps/api/core";
import type { Nullable } from "@maus-inc/types";
import { showErrorSnackbar, showSnackbar } from "../actions/app.actions";
import { tryRegisterCurrentAppTarget } from "../actions/app-target.actions";
import { showToast } from "../actions/toast.actions";
import {
  postProcessTranscript,
  type PostProcessMetadata,
} from "../actions/transcribe.actions";
import { getAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";
import { getLogger } from "../utils/log.utils";
import {
  routeTranscriptOutput,
  appendToDictationBacklog,
  clearDictationBacklog,
  drainDictationBacklog,
  hasDictationBacklog,
  incrementDictationBacklogNonce,
} from "../utils/output-routing.utils";
import { sanitizeTranscriptText } from "../utils/sanitize-transcript.utils";
import { getToneIdToUse, VERBATIM_TONE_ID } from "../utils/tone.utils";
import {
  getMyDictationLanguage,
  getMyUserPreferences,
} from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

/**
 * Thin wrapper around the Tauri `check_focused_paste_target` command.
 * Returns the target state without any side effects.
 */
async function checkFocusedPasteTarget(): Promise<
  "editable" | "not_editable" | "unknown"
> {
  try {
    const state = await invoke<"editable" | "not_editable" | "unknown">(
      "check_focused_paste_target",
    );
    return state;
  } catch (error) {
    getLogger().warning(`check_focused_paste_target failed: ${error}`);
    return "unknown";
  }
}

export class DictationStrategy extends BaseStrategy {
  private streamedSegmentCount = 0;
  private streamedProcessedText = "";
  private pasteQueue: Promise<void> = Promise.resolve();
  private currentAppId: string | null = null;
  /** True when the last known paste target was NOT editable, meaning
   *  segments are being backlogged instead of pasted live. */
  private backlogActive = false;

  shouldStoreTranscript(): boolean {
    return true;
  }

  get hasStreamedSegments(): boolean {
    return this.streamedSegmentCount > 0;
  }

  private getActiveRemoteTargetDeviceId(): string | null {
    const prefs = getMyUserPreferences(getAppState());
    if (!prefs?.remoteOutputEnabled || !prefs.remoteTargetDeviceId) {
      return null;
    }
    return prefs.remoteTargetDeviceId;
  }

  /**
   * Drain the accumulated backlog, track the trailing space in
   * `streamedProcessedText`, and log/recover from any failure.
   * Returns `true` when text was delivered.
   *
   * This is the single place backlog-drain + trailing-space bookkeeping
   * happens, so the two callers (checkAndDrainBacklog,
   * handleInterimSegment) cannot desync or double-space.
   */
  private async drainBacklogAndAppendSpace(newSegment?: string): Promise<boolean> {
    try {
      const result = await drainDictationBacklog(newSegment, this.currentAppId);
      // Only add a trailing separator when this is a standalone drain
      // (no newSegment).  When the caller provides newSegment it has
      // already appended the segment text to streamedProcessedText, so
      // adding another space here would double-space.
      if (result.delivered && !newSegment) {
        this.streamedProcessedText += " ";
      }
      return result.delivered;
    } catch (error) {
      getLogger().error(`Backlog drain failed: ${error}`);
      return false;
    }
  }

  /**
   * Probe the currently focused element and, if it is editable (or the
   * platform cannot tell), drain any accumulated dictation backlog into it.
   *
   * Fire-and-forget (logging errors internally). Safe to call from a
   * polling interval — the operation is serialised on `this.pasteQueue`
   * so it never races an in-flight interim segment.
   */
  checkAndDrainBacklog(): Promise<void> {
    const promise = this.pasteQueue.then(async () => {
      if (!hasDictationBacklog() && !this.backlogActive) {
        return;
      }

      const state = await checkFocusedPasteTarget();
      if (state === "editable" || state === "unknown") {
        // Target is now editable (or we can't tell — try paste anyway).
        if (hasDictationBacklog()) {
          await this.drainBacklogAndAppendSpace();
        }
        this.backlogActive = false;
      }
    });
    this.pasteQueue = promise;
    return promise;
  }

  handleInterimSegment(segment: string): void {
    const state = getAppState();

    const prefs = getMyUserPreferences(state);
    const realtimeEnabled = prefs?.realtimeOutputEnabled ?? false;
    const toneId = getToneIdToUse(state);
    if (!realtimeEnabled || toneId !== VERBATIM_TONE_ID) {
      return;
    }

    const sanitized = this.sanitizeTranscript(segment, { interim: true });
    if (!sanitized) {
      return;
    }

    const isFirst = this.streamedSegmentCount === 0;
    this.streamedSegmentCount++;

    this.pasteQueue = this.pasteQueue.then(async () => {
      const text = sanitized;
      // Interim sanitize skips structural commands, so this rarely ends with
      // "\n"; keep the branch for replacement/symbol output that already
      // includes a trailing newline.
      const textToPaste = text.endsWith("\n") ? text : `${text} `;
      this.streamedProcessedText += (isFirst ? "" : " ") + text;

      // Remote mode bypasses the backlog altogether.
      if (prefs?.remoteOutputEnabled && prefs.remoteTargetDeviceId) {
        try {
          await routeTranscriptOutput({
            text: textToPaste,
            mode: "dictation",
            currentAppId: this.currentAppId,
            skipReview: true,
          });
        } catch (error) {
          getLogger().error(
            `Failed to remote-deliver interim segment: ${error}`,
          );
        }
        return;
      }

      // -- Backlog-aware routing ---------------------------------------------
      const target = await checkFocusedPasteTarget();

      if (target === "not_editable") {
        // No editable target: accumulate, don't paste, don't flash.
        this.backlogActive = true;
        appendToDictationBacklog(text);
        return;
      }

      // Target is editable (or unknown -- optimistically try to paste).
      // Drain any accumulated backlog first, then paste the current segment.
      if (hasDictationBacklog()) {
        await this.drainBacklogAndAppendSpace(text);
        this.backlogActive = false;
        return;
      }

      // No backlog -- paste this segment live as before.
      this.backlogActive = false;
      try {
        await routeTranscriptOutput({
          text: textToPaste,
          mode: "dictation",
          currentAppId: this.currentAppId,
          skipReview: true,
        });
      } catch (error) {
        getLogger().error(`Failed to paste interim segment: ${error}`);
      }
    });
  }

  private sanitizeTranscript(
    text: string,
    opts?: { interim?: boolean },
  ): string | null {
    const state = getAppState();
    const prefs = getMyUserPreferences(state);
    const replacementRules = Object.values(state.termById)
      .filter((term) => term.isReplacement)
      .map((term) => ({
        sourceValue: term.sourceValue,
        destinationValue: term.destinationValue,
      }));

    const sanitized = sanitizeTranscriptText({
      rawTranscript: text,
      replacementRules,
      language: getMyDictationLanguage(state),
      spokenCommandsEnabled: prefs?.spokenCommandsEnabled ?? true,
      hallucinationFilterEnabled: prefs?.hallucinationFilterEnabled ?? true,
      skipStructuralCommands: opts?.interim === true,
    });
    // Preserve structural whitespace such as "\n" from spoken "new line".
    return /^[ \t]*$/.test(sanitized) ? null : sanitized;
  }

  validateAvailability(): Nullable<StrategyValidationError> {
    // The mausVoice Cloud word-limit check was removed with the cloud
    // offering in 0.1.6; local and API dictation are always available.
    return null;
  }

  async loadAppTarget(): Promise<void> {
    try {
      const appTarget = await tryRegisterCurrentAppTarget();
      this.currentAppId = appTarget?.id ?? null;
    } catch {
      getLogger().verbose("Failed to resolve current app target at start");
    }
  }

  async onBeforeStart(): Promise<void> {
    // Initialize session backlog state and load app target
    clearDictationBacklog();
    incrementDictationBacklogNonce();
    this.loadAppTarget();
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    await invoke<void>("set_phase", { phase });
  }

  private async handleFinalStreamedTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    const sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);

    await this.pasteQueue;

    // Drain any remaining backlog before the transcript is finalized.
    if (hasDictationBacklog()) {
      getLogger().info(
        `Draining backlog segment(s) on finalize`,
      );
      await this.drainBacklogAndAppendSpace();
    }

    // Interim paste already hit the focused app without structural commands
    // (chunk-safe). The saved transcript uses the full sanitize so scratch /
    // new-line are recorded. We do not rewrite already-streamed keystrokes.
    const transcript =
      sanitizedTranscript ?? this.streamedProcessedText ?? null;
    getLogger().verbose(
      `Streaming dictation complete (${this.streamedSegmentCount} segments)`,
    );

    return {
      shouldContinue: false,
      transcript: transcript,
      sanitizedTranscript,
      postProcessMetadata: {},
      postProcessWarnings: [],
      remoteStatus: null,
      remoteDeviceId: null,
    };
  }

  private async handleFinalBulkTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    let transcript: string | null = null;
    let sanitizedTranscript: string | null = null;
    let postProcessMetadata: PostProcessMetadata = {};
    let postProcessWarnings: string[] = [];
    let remoteStatus: "sent" | null = null;
    const remoteDeviceId = this.getActiveRemoteTargetDeviceId();

    try {
      sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
      if (sanitizedTranscript) {
        if (args.processedTranscript) {
          transcript = args.processedTranscript;
          postProcessMetadata = args.serverPostProcessMetadata ?? {};
        } else {
          const result = await postProcessTranscript({
            rawTranscript: sanitizedTranscript,
            toneId: args.toneId,
          });

          transcript = result.transcript;
          postProcessMetadata = result.metadata;
          postProcessWarnings = result.warnings;
        }
      }

      if (transcript) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        try {
          getLogger().verbose(
            `Routing transcript output (${transcript.length} chars, app=${args.currentApp?.id ?? "none"})`,
          );

          const textToPaste = transcript.trim() + " ";
          const result = await routeTranscriptOutput({
            text: textToPaste,
            mode: "dictation",
            currentAppId: args.currentApp?.id ?? null,
          });
          if (result.remote && result.delivered) {
            remoteStatus = "sent";
            showSnackbar("Transcript sent to paired receiver.", {
              mode: "success",
            });
          }

          getLogger().info("Transcript output routed successfully");
        } catch (error) {
          getLogger().error(`Failed to route transcription output: ${error}`);
          showErrorSnackbar(
            error instanceof Error
              ? error.message
              : String(error) || "Unable to insert transcription.",
          );
        }
      }
    } catch (error) {
      getLogger().error(`Failed to process transcription: ${error}`);

      const errorMessage =
        error instanceof Error ? error.message : "An error occurred.";
      postProcessWarnings.push(errorMessage);

      await showToast({
        message: "Transcription failed",
        toastType: "error",
      });
    }

    return {
      shouldContinue: false,
      transcript,
      sanitizedTranscript,
      postProcessMetadata,
      postProcessWarnings,
      remoteStatus,
      remoteDeviceId: remoteStatus ? remoteDeviceId : null,
    };
  }

  async handleTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    if (this.hasStreamedSegments) {
      return this.handleFinalStreamedTranscript(args);
    } else {
      return this.handleFinalBulkTranscript(args);
    }
  }

  async cleanup(): Promise<void> {
    // Reset the streaming state so a stale queued paste can't chain into the
    // next session. The in-flight promise is replaced: any paste that already
    // started is allowed to complete, but no new work queues onto it and the
    // final-transcript path will not wait on a stale queue.
    this.pasteQueue = Promise.resolve();
    this.streamedSegmentCount = 0;
    this.streamedProcessedText = "";
    this.currentAppId = null;
    this.backlogActive = false;
    clearDictationBacklog();
  }
}
