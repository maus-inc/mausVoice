import { COMPUTER_USE_MAX_TURNS } from "@maus-inc/voice-ai";
import {
  createComputerUseSessionFactory,
  supportsComputerUse,
} from "@maus-inc/voice-ai";
import type { ComputerUseSession } from "@maus-inc/types";
import { getAgentModePrefs } from "../../utils/user.utils";
import { getAppState } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { ComputerUseLoop, type ComputerUseEvent } from "./computer-use-loop";
import { requestComputerUseApproval } from "./computer-use-approval";
import { tauriComputerUseHost } from "./tauri-computer-use.host";

const log = getLogger();

/**
 * Instructions that hold whatever the provider's own prompt says.
 *
 * A model reading a screenshot can be told by the page to do something else.
 * Saying so here costs nothing and is the only place the app gets to speak
 * before the first action, since both providers take their own system prompt.
 */
export const COMPUTER_USE_SYSTEM_PROMPT = [
  "You are operating the user's computer on their behalf, one step at a time.",
  "Look at the screenshot, decide the single next action, and stop after each one to see the result.",
  "Prefer the keyboard and the accessibility tree over guessing at pixels when a shortcut exists.",
  "Never retype text the user can see on screen when you could read it instead.",
  "If an action did not work, change your approach rather than repeating it.",
  "Stop as soon as the goal is met, and say plainly if it cannot be done.",
].join(" ");

export type ComputerUseStartResult =
  { ok: true; loop: ComputerUseLoop } | { ok: false; message: string };

const activeLoops = new Map<string, ComputerUseLoop>();

/**
 * Build a loop for a conversation, or explain why there is none.
 *
 * Every reason this can fail is a sentence a user can act on. "Unsupported
 * provider" without the provider named is the kind of error that costs a
 * support round.
 */
export const createComputerUseLoop = ({
  conversationId,
  goal,
  signal,
}: {
  conversationId: string;
  goal: string;
  signal?: AbortSignal;
}): ComputerUseStartResult => {
  const prefs = getAgentModePrefs(getAppState());
  if (prefs.mode !== "api") {
    return {
      ok: false,
      message:
        "Computer use needs an API model. Choose one in assistant mode settings first.",
    };
  }
  if (!supportsComputerUse(prefs.provider)) {
    return {
      ok: false,
      message: `${providerLabel(prefs.provider)} cannot drive the screen. Pick a computer use capable model in assistant mode settings.`,
    };
  }

  const model = prefs.postProcessingModel;
  if (!model) {
    return {
      ok: false,
      message: "No model is selected for assistant mode.",
    };
  }

  const factory = createComputerUseSessionFactory(prefs.provider, {
    apiKey: prefs.apiKeyValue,
    model,
  });
  if (!factory) {
    return {
      ok: false,
      message: `${providerLabel(prefs.provider)} cannot drive the screen.`,
    };
  }

  const session: ComputerUseSession = factory.create();

  // A previous run for this conversation owns the screen until it is told to
  // stop. Two loops clicking at once is worse than refusing the second.
  const previous = activeLoops.get(conversationId);
  if (previous?.isRunning) {
    return {
      ok: false,
      message: "An earlier computer use run is still going. Stop it first.",
    };
  }

  // The approval callback closes over the loop, and the loop's config is what
  // carries the callback, so the reference is filled in immediately after the
  // constructor returns. Approval always runs inside `loop.run()`, which is
  // only reached after this assignment.
  let created: ComputerUseLoop | undefined;
  created = new ComputerUseLoop({
    session,
    host: tauriComputerUseHost,
    goal,
    systemPrompt: COMPUTER_USE_SYSTEM_PROMPT,
    maxTurns: COMPUTER_USE_MAX_TURNS,
    stuckTurnsBeforeGivingUp: 3,
    requestApproval: (request) =>
      requestComputerUseApproval(request, {
        conversationId,
        signal,
        isStopped: () => created?.isAborted === true,
      }),
  });
  const loop = created;

  activeLoops.set(conversationId, loop);
  log.verbose(
    `Starting a computer use run for ${conversationId} on ${factory.providerId}`,
  );
  return { ok: true, loop };
};

/** Stop the conversation's run. Safe when there is none. */
export const abortComputerUse = (conversationId: string): void => {
  activeLoops.get(conversationId)?.abort();
};

/**
 * Forget a loop that has finished driving itself.
 *
 * Identity-checked so a run cannot deregister the run that replaced it.
 */
export const releaseComputerUseLoop = (
  conversationId: string,
  loop: ComputerUseLoop,
): void => {
  if (activeLoops.get(conversationId) === loop) {
    activeLoops.delete(conversationId);
  }
};

export const isComputerUseRunning = (conversationId: string): boolean =>
  activeLoops.get(conversationId)?.isRunning ?? false;

/**
 * Drive the loop and hand each event to the caller.
 *
 * The caller owns persistence. This function owns exactly two things: the loop's
 * lifetime and the promise that it is not left running once the caller stops
 * listening, which is what happens when the window closes mid-run.
 */
export const runComputerUse = async (
  conversationId: string,
  loop: ComputerUseLoop,
  onEvent: (event: ComputerUseEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  try {
    for await (const event of loop.run(signal)) {
      onEvent(event);
    }
  } finally {
    if (activeLoops.get(conversationId) === loop) {
      activeLoops.delete(conversationId);
    }
  }
};

/** Only used by tests, which need a clean map between cases. */
export const resetComputerUseLoopsForTest = (): void => {
  for (const loop of activeLoops.values()) {
    loop.abort();
  }
  activeLoops.clear();
};

const providerLabel = (providerId: string): string =>
  providerId.charAt(0).toUpperCase() + providerId.slice(1);
