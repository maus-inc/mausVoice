import type {
  CapturedFrame,
  DisplayGeometry,
} from "@maus-inc/desktop-native-apis";
import type {
  ComputerUseAction,
  ComputerUseActionResult,
  ComputerUseSession,
  ComputerUseTurn,
} from "@maus-inc/types";
import { getLogger } from "../../utils/log.utils";
import {
  executeComputerUseAction,
  SCREENSHOT_MAX_WIDTH,
  transformFor,
  type CaptureTransform,
  type ComputerUseHost,
} from "./computer-use-executor";
import {
  classifyComputerUseAction,
  needsComputerUseApproval,
} from "./computer-use-risk";

const log = getLogger();

export const COMPUTER_USE_EVENTS = [
  "turn-start",
  "text",
  "action",
  "action-result",
  "finish",
] as const;

export type ComputerUseEventType = (typeof COMPUTER_USE_EVENTS)[number];

export type ComputerUseEvent =
  | { type: "turn-start"; turn: number }
  | { type: "text"; text: string }
  // `callId` is on both halves of a pair on purpose. A consumer that has to
  // reconstruct the link itself will guess wrong the moment a turn contains two
  // actions of the same type, which is the normal case for a click followed by
  // a wait.
  | {
      type: "action";
      turn: number;
      callId: string;
      action: ComputerUseAction;
    }
  | {
      type: "action-result";
      turn: number;
      result: ComputerUseActionResult;
      /** The permission the approval went through, when one was needed. */
      permissionId?: string;
    }
  | { type: "finish"; reason: ComputerUseFinishReason; message?: string };

export type ComputerUseFinishReason =
  "done" | "max-turns" | "aborted" | "error" | "stuck";

export type ComputerUseApprovalRequest = {
  action: ComputerUseAction;
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  warning?: string;
};

/** Answer one approval request. `always` is the user's "stop asking for this". */
export type ComputerUseApprovalAnswer = "approve" | "deny" | "always";

/**
 * The answer plus the permission the answer refers to.
 *
 * The id is carried back rather than invented at the point of display, because
 * the permission store mints it and nothing else can predict it. A consumer
 * that guesses an id shows a denial as a failure, since it finds no matching
 * permission to read the real verdict from.
 */
export type ComputerUseApprovalOutcome = {
  answer: ComputerUseApprovalAnswer;
  permissionId?: string;
};

export type ComputerUseLoopConfig = {
  session: ComputerUseSession;
  host: ComputerUseHost;
  goal: string;
  systemPrompt: string;
  maxTurns: number;
  /** How many times one repeated action is allowed before the loop gives up. */
  stuckTurnsBeforeGivingUp: number;
  /** Ask the user about one action. Returns how they answered. */
  requestApproval?: (
    request: ComputerUseApprovalRequest,
  ) => Promise<ComputerUseApprovalOutcome>;
  onEvent?: (event: ComputerUseEvent) => void;
};

/**
 * A signature for "the same thing again", used to notice a loop.
 *
 * Coordinates are rounded to a coarse grid first. Without that, an agent that
 * retries a click a few pixels off looks like new work every single turn, and
 * the stuck detector never fires on the one case it exists for.
 */
const actionFingerprint = (action: ComputerUseAction): string => {
  const coarse = (value: number): number => Math.round(value / 16);
  switch (action.type) {
    case "click":
      return `click:${action.button ?? "left"}:${action.clicks ?? 1}:${coarse(
        action.x,
      )},${coarse(action.y)}`;
    case "type":
      return `type:${action.text}`;
    case "key":
      return `key:${action.keys.join("+")}:${action.repeat ?? 1}`;
    case "key_down":
    case "key_up":
      return `${action.type}:${action.keys.join("+")}`;
    case "drag":
      return `drag:${coarse(action.fromX)},${coarse(action.fromY)}->${coarse(
        action.toX,
      )},${coarse(action.toY)}`;
    case "scroll":
      return `scroll:${action.direction}:${action.amount}`;
    case "move":
      return `move:${coarse(action.x)},${coarse(action.y)}`;
    case "wait":
      return `wait:${action.ms}`;
    case "zoom":
      return `zoom:${action.region.x0},${action.region.y0},${action.region.x1},${action.region.y1}`;
    case "mouse_down":
    case "mouse_up":
      return `${action.type}:${action.button ?? "left"}`;
    case "screenshot":
    case "cursor_position":
    case "unsupported":
      return action.type;
  }
};

const turnIsUnproductive = (turn: ComputerUseTurn): boolean =>
  turn.actions.length === 0 ||
  turn.actions.every((a) => a.action.type === "wait");

/**
 * Watch for an agent going in circles.
 *
 * Three signals, because one of them on its own produces false alarms. A
 * repeated action is the strongest and needs the longest run. A turn that
 * achieves nothing is weaker on its own, since waiting is sometimes what the
 * screen needed. A screen that has not changed across several turns is the
 * third, and it is what catches an agent clicking a button that does nothing.
 */
export class StuckDetector {
  private readonly fingerprints: string[] = [];
  private readonly maxFingerprintRun: number;
  private emptyTurns = 0;
  private unchangedScreens = 0;
  private previousScreenshot: string | null = null;

  constructor(maxFingerprintRun = 4) {
    this.maxFingerprintRun = maxFingerprintRun;
  }

  /** True when this turn is the moment to stop. */
  observeTurn(turn: ComputerUseTurn, screenshotDigest: string): boolean {
    if (turnIsUnproductive(turn)) {
      this.emptyTurns += 1;
    } else {
      this.emptyTurns = 0;
    }

    for (const request of turn.actions) {
      this.fingerprints.push(actionFingerprint(request.action));
    }
    // Bounded so a long run cannot grow this without limit. The cap is a
    // multiple of the run length because `repeatedAction` looks at a window,
    // and a window larger than the history would never be satisfiable.
    const cap = this.maxFingerprintRun * 3;
    if (this.fingerprints.length > cap) {
      this.fingerprints.splice(0, this.fingerprints.length - cap);
    }

    if (this.previousScreenshot === screenshotDigest) {
      this.unchangedScreens += 1;
    } else {
      this.unchangedScreens = 0;
      this.previousScreenshot = screenshotDigest;
    }

    return this.isStuck();
  }

  /** Why it thinks the agent is stuck, for a message the user can act on. */
  reason(): string {
    if (this.repeatedAction()) {
      return "It kept repeating the same action without the screen changing.";
    }
    if (this.emptyTurns >= 3) {
      return "Three turns in a row did not do anything.";
    }
    return `The screen has not changed for ${this.unchangedScreens} turns.`;
  }

  isStuck(): boolean {
    return (
      this.repeatedAction() !== null ||
      this.emptyTurns >= 3 ||
      this.unchangedScreens >= 4
    );
  }

  private repeatedAction(): string | null {
    const run = this.fingerprints.length - 1;
    if (run < this.maxFingerprintRun) {
      return null;
    }
    const tail =
      this.fingerprints[this.fingerprints.length - this.maxFingerprintRun];
    if (this.fingerprints.every((f) => f === tail)) {
      return tail;
    }
    return null;
  }
}

/** A cheap content digest. The bytes are already base64 and never leave the machine twice. */
const digestOf = (frame: CapturedFrame): string => {
  let hash = 0x811c9dc5;
  const sample = frame.data;
  for (let i = 0; i < sample.length; i += 1) {
    hash ^= sample.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${frame.imageWidth}x${frame.imageHeight}:${hash.toString(16)}`;
};

const captureForModel = async (
  host: ComputerUseHost,
): Promise<CaptureTransform> => {
  const displays: DisplayGeometry[] = await host.listDisplays();
  if (displays.length === 0) {
    throw new Error("No display was found, so there is nothing to look at.");
  }
  const frame = await host.captureScreen({
    maxWidth: SCREENSHOT_MAX_WIDTH,
    // Always PNG. Some providers reject a conversation whose image is not PNG,
    // and the rejection lands a turn later naming nothing about the first one.
    format: "png",
  });
  return transformFor(frame, displays);
};

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new AbortError();
  }
};

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/**
 * Runs a task by looking at the screen and acting on it.
 *
 * This is the whole of the provider knowledge above the adapters: it takes a
 * `ComputerUseSession` and never learns which provider produced it. Gemini
 * continues a named interaction, Anthropic resends its messages, and neither
 * difference is visible here.
 */
export class ComputerUseLoop {
  private readonly config: ComputerUseLoopConfig;
  private aborted = false;
  private running = false;
  private approvalCount = 0;
  /** Actions the user said to stop asking about, as fingerprints. */
  private readonly alwaysAllowed = new Set<string>();

  constructor(config: ComputerUseLoopConfig) {
    this.config = config;
  }

  abort(): void {
    this.aborted = true;
    // Tell the OS side too. A long wait or a held key does not come back just
    // because the JavaScript loop stopped looking at it.
    void this.config.host.computerUseCancel().catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Whether the user asked this run to stop.
   *
   * The approval poll needs this, because Stop reaches the run through
   * `abort()` rather than through an `AbortSignal`: production never supplies
   * one, so a poll that only watches a signal waits out its full timeout after
   * the user has pressed Stop.
   */
  get isAborted(): boolean {
    return this.aborted;
  }

  async *run(signal?: AbortSignal): AsyncGenerator<ComputerUseEvent> {
    if (this.running) {
      throw new Error("This computer use run is already in progress.");
    }
    this.running = true;
    // `aborted` is deliberately NOT reset here. `run` is a generator, so this
    // line would execute on the first `next()`, not at the call: an abort
    // landing between construction and the first event would be discarded, and
    // the run would start anyway. Each run gets a fresh loop, so there is
    // nothing to reset.
    this.approvalCount = 0;
    this.alwaysAllowed.clear();

    const stuck = new StuckDetector(this.config.stuckTurnsBeforeGivingUp);
    let turn = 0;
    try {
      let view = await captureForModel(this.config.host);
      let pendingResults: ComputerUseActionResult[] = [];

      for (;;) {
        abortIfRequested(signal);
        if (this.aborted) {
          yield { type: "finish", reason: "aborted" };
          return;
        }
        if (turn >= this.config.maxTurns) {
          yield {
            type: "finish",
            reason: "max-turns",
            message: `Stopped after ${this.config.maxTurns} turns without finishing.`,
          };
          return;
        }

        turn += 1;
        yield { type: "turn-start", turn };

        const reply: ComputerUseTurn =
          pendingResults.length === 0
            ? await this.config.session.start({
                systemPrompt: this.config.systemPrompt,
                goal: this.config.goal,
                screenshot: toModelScreenshot(view.frame),
                displayWidth: view.frame.sourceWidth,
                displayHeight: view.frame.sourceHeight,
              })
            : await this.config.session.advance({
                results: pendingResults,
                screenshot: toModelScreenshot(view.frame),
                displayWidth: view.frame.sourceWidth,
                displayHeight: view.frame.sourceHeight,
              });

        if (reply.text) {
          yield { type: "text", text: reply.text };
        }

        if (reply.actions.length === 0) {
          yield { type: "finish", reason: "done" };
          return;
        }

        if (stuck.observeTurn(reply, digestOf(view.frame))) {
          yield {
            type: "finish",
            reason: "stuck",
            message: stuck.reason(),
          };
          return;
        }

        // Every call the model made gets exactly one result. A provider rejects the
        // next request outright if any `tool_use` is left unanswered, so a
        // short results array is not a smaller reply, it is a dead run.
        const results: ComputerUseActionResult[] = [];
        for (const request of reply.actions) {
          yield {
            type: "action",
            turn,
            callId: request.callId,
            action: request.action,
          };
          const approval = await this.answerApproval(request.action);
          if (approval.answer === "always") {
            this.alwaysAllowed.add(actionFingerprint(request.action));
          }
          abortIfRequested(signal);
          if (this.aborted) {
            break;
          }
          const result = await executeComputerUseAction({
            host: this.config.host,
            transform: view,
            callId: request.callId,
            providerName: request.providerName,
            action: request.action,
            approved: approval.answer !== "deny",
          });
          yield {
            type: "action-result",
            turn,
            result,
            ...(approval.permissionId
              ? { permissionId: approval.permissionId }
              : {}),
          };
          results.push(result);
        }

        // A short batch means the user stopped mid-turn. Ending here rather
        // than padding the array is deliberate: an aborted run sends nothing
        // more, so there is no unanswered call for a later request to trip on.
        if (this.aborted || results.length !== reply.actions.length) {
          yield { type: "finish", reason: "aborted" };
          return;
        }

        // Only a new screenshot between turns. Re-capturing mid-turn would show
        // the model a half-applied batch and it would plan the next turn around
        // a state that no longer exists.
        view = await captureForModel(this.config.host);
        pendingResults = results;
      }
    } catch (error) {
      if (error instanceof AbortError || this.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Computer use run failed: ${message}`);
      yield { type: "finish", reason: "error", message };
    } finally {
      this.running = false;
      await this.config.host.computerUseResetCancel().catch(() => undefined);
    }
  }

  private async answerApproval(
    action: ComputerUseAction,
  ): Promise<ComputerUseApprovalOutcome> {
    if (!needsComputerUseApproval(action)) {
      return { answer: "approve" };
    }
    const fingerprint = actionFingerprint(action);
    if (this.alwaysAllowed.has(fingerprint)) {
      return { answer: "approve" };
    }
    if (!this.config.requestApproval) {
      // No way to ask means no way to say yes. Approving here would make
      // computer use work in a context where the user cannot see it happen.
      return { answer: "deny" };
    }
    const approval = classifyComputerUseAction(action);
    this.approvalCount += 1;
    // Asked here rather than only inside the approval helper, because this is
    // the one place that knows the loop was stopped. An approval poll driven
    // purely by an external signal would wait out its full timeout after Stop,
    // since production supplies no signal at all.
    if (this.aborted) {
      return { answer: "deny" };
    }
    return this.config.requestApproval({
      action,
      risk: approval.risk,
      summary: approval.summary,
      ...(approval.warning ? { warning: approval.warning } : {}),
    });
  }
}

const toModelScreenshot = (
  frame: CapturedFrame,
): {
  data: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
} => ({
  data: frame.data,
  mimeType: frame.mimeType === "image/png" ? "image/png" : "image/jpeg",
  width: frame.imageWidth,
  height: frame.imageHeight,
});
