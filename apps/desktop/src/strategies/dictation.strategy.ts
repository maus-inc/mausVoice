import { invoke } from "@tauri-apps/api/core";
import type { Nullable, RouteTranscriptOutputResult } from "@maus-inc/types";
import { showErrorSnackbar, showSnackbar } from "../actions/app.actions";
import { tryRegisterCurrentAppTarget } from "../actions/app-target.actions";
import { getIntl } from "../i18n/intl";
import { postProcessErrorReason } from "../actions/post-process-error-category";
import { runToast, showToast } from "../actions/toast.actions";
import {
  postProcessTranscript,
  type PostProcessMetadata,
} from "../actions/transcribe.actions";
import { getAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  HistoryOwner,
  StrategyValidationError,
} from "../types/strategy.types";
import { getLogger } from "../utils/log.utils";
import { sendPillStageText } from "../utils/overlay.utils";
import {
  routeTranscriptOutput,
  appendToDictationBacklog,
  clearDictationBacklog,
  drainDictationBacklog,
  hasDictationBacklog,
  incrementDictationBacklogNonce,
} from "../utils/output-routing.utils";
import { sanitizeTranscriptText } from "../utils/sanitize-transcript.utils";
import { withTimeout } from "../utils/timeout.utils";
import { getToneIdToUse, VERBATIM_TONE_ID } from "../utils/tone.utils";
import {
  getMyDictationLanguage,
  getMyUserPreferences,
} from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

const retiredTranscriptResult = (): HandleTranscriptResult => ({
  shouldContinue: false,
  transcript: null,
  sanitizedTranscript: null,
  postProcessMetadata: {},
  postProcessWarnings: [],
});

type BulkDeliveryInput = {
  transcript: string;
  sanitizedTranscript: string | null;
  postProcessMetadata: PostProcessMetadata;
  postProcessWarnings: string[];
  args: HandleTranscriptParams;
};
type BulkDeliveryState = {
  transcript: string;
  historyOwner: HistoryOwner;
  remoteStatus: "sent" | null;
};

/** Adopt an edited review immediately, even if its persistence later throws. */
function persistDeliveredReview(
  state: BulkDeliveryState,
  result: RouteTranscriptOutputResult,
  original: string,
  input: BulkDeliveryInput,
): Promise<void> | undefined {
  if (
    !result.delivered ||
    result.deliveredText === null ||
    result.deliveredText === original
  )
    return;
  state.transcript = result.deliveredText;
  if (!input.args.persistReviewedTranscript) return;
  return input.args
    .persistReviewedTranscript({
      transcript: state.transcript,
      sanitizedTranscript: input.sanitizedTranscript,
      postProcessMetadata: input.postProcessMetadata,
      postProcessWarnings: input.postProcessWarnings,
    })
    .then((saved) => {
      state.historyOwner = saved ? "review" : "review-unconfirmed";
    });
}

/** Notify only after the paired receiver actually accepted the output. */
function notifyRemoteDelivery(
  state: BulkDeliveryState,
  result: RouteTranscriptOutputResult,
): void {
  if (!result.remote || !result.delivered) return;
  state.remoteStatus = "sent";
  showSnackbar("Transcript sent to paired receiver.", { mode: "success" });
}

function reportOutputRoutingFailure(error: unknown): void {
  getLogger().error(`Failed to route transcription output: ${error}`);
  showErrorSnackbar(
    error instanceof Error
      ? error.message
      : String(error) || "Unable to insert transcription.",
  );
}

/** Cap how long start waits on focused-app resolution so a hung native call
 * cannot block recording indefinitely. Misses leave currentAppId null. */
const LOAD_APP_TARGET_TIMEOUT_MS = 1500;

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

/**
 * Warn when the online styling failed but the local fast style still produced
 * usable output: the transcript is delivered, so this must not block.
 *
 * The `postProcessError` half is not decoration, and it points the way it looks
 * like it should not. `postProcessFallback` is set on two different runs and
 * `transcriptions.actions.ts` says so in its own words -- "covers two different
 * runs and cannot be read on its own". This one did not, so it toasted for both.
 *
 * The two runs separate on the error being present, and this is the direction
 * that is easy to get backwards. A request that SUCCEEDED but returned an
 * unusable reply also sets the flag, with `postProcessFailed` left false and NO
 * error recorded (transcribe.actions.ts:402-408) -- nothing local ran there, and
 * the text is the raw ASR, so the message below claims the opposite of what
 * happened. A request that FAILED records the category, and that is the run the
 * message is written for. `isUnstyledPostProcess` reads it as
 * `postProcessFallback && !postProcessError`, which is the complementary pair.
 *
 * Nothing is lost by not toasting on the unusable reply. The run's `warnings`
 * are persisted with it (`transcribe.actions.ts:917`) and rendered in
 * TranscriptionDetailsDialog, so History shows the real state.
 *
 * Not `isUnstyledPostProcess`, which is the tempting name here: it has exactly one
 * call site, inside `updateStoredTranscription`, and that is reached only from
 * `performRetranscribe`. A fresh dictation never evaluates it. It reads the flag
 * the other way round anyway -- `postProcessFailed || (postProcessFallback &&
 * !postProcessError)` -- so its `!postProcessError` term is this `if`'s
 * `postProcessError`, negated.
 */
const warnStylingFallback = (
  metadata: PostProcessMetadata,
  isCurrent: () => boolean,
): void => {
  if (!metadata.postProcessFallback || !metadata.postProcessError) return;
  getLogger().warning(
    "Post-processing provider failed; delivered the local fast style instead",
  );
  try {
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "Online styling was unavailable, so the local style was used instead.",
        }),
        toastType: "info",
        duration: 5000,
        isCurrent,
      }),
    );
  } catch {
    getLogger().warning("Could not request the styling fallback toast");
  }
};

/**
 * Report a styling failure that blocked insertion. Returns `true` when the
 * session was retired while the message was built, so the caller must not
 * deliver anything.
 */
const reportStylingFailure = (
  metadata: PostProcessMetadata,
  isCurrent: () => boolean,
): boolean => {
  getLogger().warning("Post-processing failed; skipping transcript insertion");
  try {
    const reason = postProcessErrorReason(metadata.postProcessError);
    const message = getIntl().formatMessage(
      {
        defaultMessage:
          "Styling failed: {reason}. The final text was not inserted.",
      },
      { reason: getIntl().formatMessage(reason) },
    );
    if (!isCurrent()) return true;
    runToast(
      showToast({
        message,
        toastType: "error",
        duration: 8000,
        action: "open_transcriptions",
        isCurrent,
      }),
    );
  } catch {
    getLogger().warning("Could not request the styling failure toast");
  }
  return false;
};

/** Log and surface a failed bulk run, returning the warning to persist with it. */
const reportBulkProcessingFailure = (
  error: unknown,
  isCurrent: () => boolean,
): string => {
  getLogger().error(`Failed to process transcription: ${error}`);
  const errorMessage =
    error instanceof Error ? error.message : "An error occurred.";
  try {
    runToast(
      showToast({
        message: "Transcription failed",
        toastType: "error",
        isCurrent,
      }),
    );
  } catch {
    getLogger().warning("Could not request the transcription failure toast");
  }
  return errorMessage;
};

export class DictationStrategy extends BaseStrategy {
  private streamedSegmentCount = 0;
  private streamedProcessedText = "";
  private pasteQueue: Promise<void> = Promise.resolve();
  private currentAppId: string | null = null;
  /** True when the last known paste target was NOT editable, meaning
   *  segments are being backlogged instead of pasted live. */
  private backlogActive = false;
  /** Monotonic session generation counter to prevent in-flight async paste
   *  or backlog tasks from delivering after cleanup() runs. */
  private sessionGeneration = 0;

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
  private async drainBacklogAndAppendSpace(
    newSegment?: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const generation = this.sessionGeneration;
    const ownsDrain = () =>
      this.sessionGeneration === generation && isCurrent();
    if (!ownsDrain()) return false;
    try {
      const result = await drainDictationBacklog(
        newSegment,
        this.currentAppId,
        ownsDrain,
      );
      if (!ownsDrain()) return false;
      // Only add a trailing separator when this is a standalone drain
      // (no newSegment).  When the caller provides newSegment it has
      // already appended the segment text to streamedProcessedText, so
      // adding another space here would double-space.
      if (result.delivered && !newSegment) {
        this.streamedProcessedText += " ";
      }
      return result.delivered;
    } catch (error) {
      if (ownsDrain()) getLogger().error(`Backlog drain failed: ${error}`);
      return false;
    }
  }

  /**
   * Chain paste work onto the serial queue. The stored chain always catches
   * and logs failures, so one rejected callback cannot poison the queue and
   * silently stop every later interim segment and backlog drain.
   */
  private enqueuePasteWork(work: () => Promise<void>): Promise<void> {
    const task = this.pasteQueue.then(work);
    this.pasteQueue = task.catch((error) => {
      getLogger().error(`Queued paste work failed: ${error}`);
    });
    return this.pasteQueue;
  }

  /**
   * Probe the currently focused element and, if it is editable (or the
   * platform cannot tell), drain any accumulated dictation backlog into it.
   *
   * Fire-and-forget (logging errors internally). Safe to call from a
   * polling interval — the operation is serialised on `this.pasteQueue`
   * so it never races an in-flight interim segment.
   */
  checkAndDrainBacklog(
    isCurrentSession: () => boolean = () => true,
  ): Promise<void> {
    const generation = this.sessionGeneration;
    const isCurrent = () =>
      this.sessionGeneration === generation && isCurrentSession();
    return this.enqueuePasteWork(async () => {
      if (!isCurrent()) return;
      if (!hasDictationBacklog() && !this.backlogActive) {
        return;
      }

      const state = await checkFocusedPasteTarget();
      if (!isCurrent()) return;
      if (state === "editable" || state === "unknown") {
        // Target is now editable (or we can't tell — try paste anyway).
        if (hasDictationBacklog()) {
          await this.drainBacklogAndAppendSpace(undefined, isCurrent);
          if (!isCurrent()) return;
        }
        this.backlogActive = false;
      }
    });
  }

  handleInterimSegment(
    segment: string,
    isCurrentSession: () => boolean = () => true,
  ): void {
    if (!isCurrentSession()) return;
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
    const generation = this.sessionGeneration;
    const isCurrent = () =>
      this.sessionGeneration === generation && isCurrentSession();

    void this.enqueuePasteWork(async () => {
      if (!isCurrent()) return;
      const text = sanitized;
      // Interim sanitize skips structural commands, so this rarely ends with
      // "\n"; keep the branch for replacement/symbol output that already
      // includes a trailing newline.
      const textToPaste = text.endsWith("\n") ? text : `${text} `;
      this.streamedProcessedText += (isFirst ? "" : " ") + text;

      // Remote mode bypasses the backlog altogether.
      if (prefs?.remoteOutputEnabled && prefs.remoteTargetDeviceId) {
        try {
          // `isInterim` is load-bearing here, not decoration, and it was missing:
          // without it this call is indistinguishable from a final delivery. The
          // local branch below sets it, and `RouteTranscriptOutputArgs.isInterim`
          // documents why -- the hands-free delay applies "when you stop
          // recording", so an interim segment routed without the flag waits out
          // the full `MAX_HANDS_FREE_DELAY_MS` (60s) per segment. Those waits
          // serialise on the paste queue, so remote interim text stopped
          // streaming and arrived as one burst at the end.
          //
          // The same omission also fired the "Inserting" pill stage
          // (`deliverWithInsertionStage`) and `beginEditWatch` -- a clipboard
          // read and a toast dismissal -- on every interim segment, none of which
          // the local path does.
          await routeTranscriptOutput(
            {
              text: textToPaste,
              mode: "dictation",
              currentAppId: this.currentAppId,
              isInterim: true,
              skipReview: true,
            },
            null,
            isCurrent,
          );
        } catch (error) {
          if (isCurrent()) {
            getLogger().error(
              `Failed to remote-deliver interim segment: ${error}`,
            );
          }
        }
        return;
      }

      await this.deliverLocalInterim(text, textToPaste, isCurrent);
    });
  }

  /** Park a segment on the backlog: nothing editable, so nothing to paste. */
  private parkSegment(text: string): void {
    this.backlogActive = true;
    appendToDictationBacklog(text);
  }

  /**
   * Drain the backlog and then append this segment. A segment the drain never
   * owned is parked too, so it is not dropped on the floor.
   */
  private async drainBacklogWithSegment(
    text: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    const delivered = await this.drainBacklogAndAppendSpace(text, isCurrent);
    if (!isCurrent()) return;
    if (!delivered) {
      this.parkSegment(text);
      return;
    }
    this.backlogActive = false;
  }

  /** Paste one segment live and park it if the paste did not land. */
  private async pasteLiveInterim(
    text: string,
    textToPaste: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    try {
      const result = await routeTranscriptOutput(
        {
          text: textToPaste,
          mode: "dictation",
          currentAppId: this.currentAppId,
          isInterim: true,
          skipReview: true,
        },
        null,
        isCurrent,
      );
      if (!isCurrent()) return;
      if (!result.delivered) this.parkSegment(text);
    } catch (error) {
      if (!isCurrent()) return;
      getLogger().error(`Failed to paste interim segment: ${error}`);
      this.parkSegment(text);
    }
  }

  private async deliverLocalInterim(
    text: string,
    textToPaste: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    const target = await checkFocusedPasteTarget();
    if (!isCurrent()) return;

    if (target === "not_editable") {
      // No editable target: accumulate, don't paste, don't flash.
      this.parkSegment(text);
      return;
    }

    // Target is editable (or unknown -- optimistically try to paste).
    // Drain any accumulated backlog first, then paste the current segment.
    if (hasDictationBacklog()) {
      await this.drainBacklogWithSegment(text, isCurrent);
      return;
    }

    // No backlog -- paste this segment live as before.
    this.backlogActive = false;
    await this.pasteLiveInterim(text, textToPaste, isCurrent);
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

  async loadAppTarget(isCurrent: () => boolean = () => true): Promise<void> {
    const generation = this.sessionGeneration;
    let expired = false;
    const ownsLookup = () =>
      !expired && generation === this.sessionGeneration && isCurrent();
    try {
      const appTarget = await withTimeout(
        tryRegisterCurrentAppTarget(ownsLookup),
        LOAD_APP_TARGET_TIMEOUT_MS,
        "loadAppTarget",
        () => {
          expired = true;
        },
      );
      if (ownsLookup()) this.currentAppId = appTarget?.id ?? null;
    } catch {
      getLogger().verbose("Failed to resolve current app target at start");
    }
  }

  async onBeforeStart(isCurrent: () => boolean = () => true): Promise<void> {
    // Initialize session backlog state, then block (with timeout) until the
    // focused app id is known so interim paste has currentAppId. Style seeding
    // is owned by DictationSideEffects after loadManualStyleForCurrentApp.
    if (!isCurrent()) return;
    clearDictationBacklog();
    incrementDictationBacklogNonce();
    await this.loadAppTarget(isCurrent);
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    await invoke<void>("set_phase", { phase });
  }

  private async handleFinalStreamedTranscript(
    args: HandleTranscriptParams,
    isCurrent: () => boolean,
  ): Promise<HandleTranscriptResult> {
    const sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);

    // Drain any remaining backlog inside the serial queue. A polled drain
    // (checkAndDrainBacklog) may already be in flight; running this drain
    // outside the queue would let both snapshot and deliver the same backlog.
    await this.enqueuePasteWork(async () => {
      if (isCurrent() && hasDictationBacklog()) {
        getLogger().info("Draining backlog segment(s) on finalize");
        sendPillStageText(
          getIntl().formatMessage({ defaultMessage: "Inserting" }),
        );
        await this.drainBacklogAndAppendSpace(undefined, isCurrent);
      }
    });

    if (!isCurrent()) return retiredTranscriptResult();

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

  /** Prepare the final transcript without deciding how it will be delivered. */
  private prepareBulkTranscript(
    sanitizedTranscript: string | null,
    args: HandleTranscriptParams,
    isCurrent: () => boolean,
  ):
    | {
        transcript: string | null;
        metadata: PostProcessMetadata;
        warnings: string[];
      }
    | Promise<{
        transcript: string | null;
        metadata: PostProcessMetadata;
        warnings: string[];
      }> {
    if (!sanitizedTranscript)
      return { transcript: null, metadata: {}, warnings: [] };
    if (args.processedTranscript) {
      return {
        transcript: args.processedTranscript,
        metadata: args.serverPostProcessMetadata ?? {},
        warnings: [],
      };
    }
    const state = getAppState();
    const effectiveToneId = args.toneId ?? getToneIdToUse(state);
    const tone = effectiveToneId ? state.toneById[effectiveToneId] : undefined;
    return postProcessTranscript({
      rawTranscript: sanitizedTranscript,
      toneId: effectiveToneId,
      trace: args.trace,
      onPolishStart: tone?.shouldDisablePostProcessing
        ? undefined
        : () => {
            if (!isCurrent()) return;
            sendPillStageText(
              getIntl().formatMessage({ defaultMessage: "Polishing" }),
            );
          },
    });
  }

  /** Route a finished transcript and keep review-history ownership with the right surface. */
  private async deliverBulkTranscript(
    input: BulkDeliveryInput,
    isCurrent: () => boolean,
  ): Promise<BulkDeliveryState> {
    const { args } = input;
    const state: BulkDeliveryState = {
      transcript: input.transcript,
      historyOwner: "stop-path",
      remoteStatus: null,
    };
    try {
      const appId = args.currentApp?.id ?? null;
      getLogger().verbose(
        `Routing transcript output (${state.transcript.length} chars, app=${appId ?? "none"})`,
      );

      const textToPaste = state.transcript.trim() + " ";
      const result = await routeTranscriptOutput(
        {
          text: textToPaste,
          mode: "dictation",
          currentAppId: appId,
        },
        args.trace ?? null,
        isCurrent,
      );
      if (!isCurrent()) return state;
      const persistence = persistDeliveredReview(
        state,
        result,
        textToPaste,
        input,
      );
      if (persistence) await persistence;
      if (!isCurrent()) return state;
      notifyRemoteDelivery(state, result);

      getLogger().info("Transcript output routed successfully");
    } catch (error) {
      if (isCurrent()) reportOutputRoutingFailure(error);
    }
    return state;
  }

  private async handleFinalBulkTranscript(
    args: HandleTranscriptParams,
    isCurrent: () => boolean,
  ): Promise<HandleTranscriptResult> {
    let transcript: string | null = null;
    let sanitizedTranscript: string | null = null;
    let postProcessMetadata: PostProcessMetadata = {};
    let postProcessWarnings: string[] = [];
    let remoteStatus: "sent" | null = null;
    let historyOwner: HistoryOwner = "stop-path";
    const remoteDeviceId = this.getActiveRemoteTargetDeviceId();

    try {
      sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
      const prepared = this.prepareBulkTranscript(
        sanitizedTranscript,
        args,
        isCurrent,
      );
      const processed = prepared instanceof Promise ? await prepared : prepared;
      if (!isCurrent()) return retiredTranscriptResult();
      transcript = processed.transcript;
      postProcessMetadata = processed.metadata;
      postProcessWarnings = processed.warnings;

      warnStylingFallback(postProcessMetadata, isCurrent);

      if (!isCurrent()) return retiredTranscriptResult();
      if (postProcessMetadata.postProcessFailed) {
        if (reportStylingFailure(postProcessMetadata, isCurrent))
          return retiredTranscriptResult();
      } else if (transcript) {
        const delivery = await this.deliverBulkTranscript(
          {
            transcript,
            sanitizedTranscript,
            postProcessMetadata,
            postProcessWarnings,
            args,
          },
          isCurrent,
        );
        if (!isCurrent()) return retiredTranscriptResult();
        transcript = delivery.transcript;
        historyOwner = delivery.historyOwner;
        remoteStatus = delivery.remoteStatus;
      }
    } catch (error) {
      if (!isCurrent()) return retiredTranscriptResult();
      postProcessWarnings.push(reportBulkProcessingFailure(error, isCurrent));
    }

    return {
      shouldContinue: false,
      transcript,
      sanitizedTranscript,
      postProcessMetadata,
      postProcessWarnings,
      remoteStatus,
      remoteDeviceId: remoteStatus ? remoteDeviceId : null,
      historyOwner,
    };
  }

  async handleTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    const generation = this.sessionGeneration;
    const isCurrent = () =>
      generation === this.sessionGeneration && (args.isCurrent?.() ?? true);
    if (!isCurrent()) return retiredTranscriptResult();
    if (this.hasStreamedSegments) {
      return this.handleFinalStreamedTranscript(args, isCurrent);
    } else {
      return this.handleFinalBulkTranscript(args, isCurrent);
    }
  }

  async cleanup(isCurrent: () => boolean = () => true): Promise<void> {
    // Increment the session generation counter first so in-flight tasks and
    // deferred target probes are immediately invalidated and will not deliver.
    this.sessionGeneration++;
    this.pasteQueue = Promise.resolve();
    this.streamedSegmentCount = 0;
    this.streamedProcessedText = "";
    this.currentAppId = null;
    this.backlogActive = false;
    if (isCurrent()) clearDictationBacklog();
    if (isCurrent()) incrementDictationBacklogNonce();
  }
}
