import type { ChatToolStatus, LlmToolCall } from "@maus-inc/types";
import type { ComputerUseAction } from "@maus-inc/types";
import { getAppState, produceAppState } from "../../store";
import { createAgentRunState } from "../../state/agent.state";
import { modifyAgentState } from "../../utils/agent.utils";
import { getLogger } from "../../utils/log.utils";
import type { PersistedRunOutcome } from "../../utils/chat-parts.utils";
import { finalizeAssistantMessage } from "../finalize-assistant-message";
import { safeSideEffect } from "../run-agent";
import type { ComputerUseFinishReason } from "./computer-use-loop";
import {
  classifyComputerUseAction,
  needsComputerUseApproval,
} from "./computer-use-risk";
import {
  createComputerUseLoop,
  releaseComputerUseLoop,
} from "./run-computer-use";

const log = getLogger();

/**
 * The agent type a computer-use run reports as.
 *
 * It has its own name rather than reusing the chat agent's so the state, the
 * logs and the settings surface can tell the two apart. Nothing branches on
 * it: the run is governed by the same `AgentRunState` fields either way.
 */
export const COMPUTER_USE_AGENT_TYPE = "computer_use";

/**
 * Mirrors `COMPUTER_USE_MAX_TURNS` from the voice-ai transport, which is where
 * the provider requests are actually bounded.
 *
 * The run state needs its own number so the progress UI has something to count
 * against. Reading the provider's constant would be more honest about the
 * bound and less honest about the value shown to a user, so this one is
 * deliberately the same number with a different job.
 */
const COMPUTER_USE_MAX_ITERATIONS = 30;

/**
 * The outcome a run leaves behind in persisted history.
 *
 * `max-turns` and `stuck` are not failures the user caused and not errors the
 * app threw, so they persist as an ordinary completed message whose text
 * already explains what happened. Only `error` and `aborted` are terminal
 * flags, which is exactly what `PersistedRunOutcome` already means.
 */
const persistedOutcome = (
  reason: ComputerUseFinishReason,
): PersistedRunOutcome | undefined =>
  reason === "error" || reason === "aborted" ? reason : undefined;

const toolNameFor = (action: ComputerUseAction): string =>
  `computer_use:${action.type}`;

/**
 * Drive one computer-use task on the desktop adapter.
 *
 * Every event becomes the same app-state shape the tool-calling run produces,
 * so the existing chat list, the tool-call strip and the Stop button work
 * without a second set of components. An action is a tool call from the UI's
 * point of view: it has a name, a pending state while it waits for the user,
 * and a result.
 *
 * The loop never learns which provider is behind it. Everything provider-shaped
 * was settled in the adapter, before this function is reached.
 */
export async function runComputerUseForConversation(
  conversationId: string,
  goal: string,
  signal?: AbortSignal,
): Promise<void> {
  const start = createComputerUseLoop({ conversationId, goal, signal });
  if (!start.ok) {
    // The error state is left in place on purpose: it is how the user learns
    // why nothing happened, and the next run overwrites it. `isAgentRunning`
    // ignores `error`, so retry is not blocked.
    produceAppState((draft) => {
      draft.agentStateByConversationId[conversationId] = {
        ...createAgentRunState(COMPUTER_USE_AGENT_TYPE),
        status: "error",
        error: start.message,
      };
    });
    return;
  }

  const loop = start.loop;

  // Publish before the first event so the Stop button has something to abort
  // during the opening screenshot, which is the slowest part of the first turn.
  // The status is `calling-llm` rather than the default `idle` because `idle` is
  // what the UI reads as "no run", so an `idle` run shows Send where Stop
  // belongs and pressing it starts a second, competing run.
  produceAppState((draft) => {
    draft.agentStateByConversationId[conversationId] = {
      ...createAgentRunState(
        COMPUTER_USE_AGENT_TYPE,
        COMPUTER_USE_MAX_ITERATIONS,
      ),
      status: "calling-llm",
    };
  });

  const state = () =>
    getAppState().agentStateByConversationId[conversationId]?.agentType ===
    COMPUTER_USE_AGENT_TYPE
      ? getAppState().agentStateByConversationId[conversationId]
      : undefined;

  // An abort can arrive between the loop starting and its first turn, in which
  // case there is no run state carrying `aborted` for `isCurrent` to read, and
  // this run reports itself as current for the rest of the aborted session. The
  // signal is the authority in that window, so it is checked alongside the
  // state rather than only after the loop has had a chance to notice.
  /**
   * Whether this run still owns the conversation.
   *
   * Ownership is the question "has another run replaced me", and it is what
   * decides whether an event may still be applied. A signal abort or an
   * `aborted` flag is a different question: "did the user ask me to stop". A
   * run that was stopped still owns the conversation, and conflating the two
   * made a stopped run skip the persisted result of the action it had just
   * finished, which is the one action whose outcome the user most needs to see.
   */
  const isCurrent = (): boolean => state() !== undefined;

  /**
   * Whether this run should keep writing.
   *
   * False once the run has been stopped. An abort can arrive before the run
   * state exists, in which case there is no `aborted` flag for `state()` to
   * read, so the signal is the authority in that window.
   */
  const isActive = (): boolean => {
    if (signal?.aborted) return false;
    const run = state();
    return run === undefined || !run.aborted;
  };

  const updateRunState: typeof produceAppState = (recipe) => {
    if (isActive()) produceAppState(recipe);
  };

  let currentMessageId: string | null = null;
  let text = "";
  let toolCalls: LlmToolCall[] = [];
  let toolStatuses: Record<string, ChatToolStatus> = {};
  /**
   * The action behind each in-flight call id.
   *
   * The loop emits `action` before it runs the action and `action-result`
   * afterwards, so a result alone does not say what ran. A batch routinely
   * holds two clicks, and matching by position would pair the wrong one the
   * moment a batch is trimmed.
   */
  const actionByCallId = new Map<string, ComputerUseAction>();

  const persistCurrentMessage = async (
    label: string,
    outcome?: PersistedRunOutcome,
  ) => {
    const messageId = currentMessageId;
    if (!messageId) return;
    await safeSideEffect(label, { conversationId }, () =>
      finalizeAssistantMessage(
        messageId,
        text,
        toolCalls,
        toolStatuses,
        outcome,
        // Ownership, not liveness. A stopped run still owns the conversation,
        // and its last action's result is exactly what the user needs to see
        // after pressing stop. Gating this on `isActive` would drop it, and the
        // tool-calling run has always persisted a stopped run's final message
        // with `runOutcome: "aborted"` attached.
        isCurrent,
      ),
    );
  };

  const startTurn = async (turn: number) => {
    // One message per turn. A model often says something useful only after
    // several steps, and folding all of it into one bubble would hide which
    // step of the task it belongs to.
    await persistCurrentMessage("computer-use.turn.finalizePrevious");
    const newMessageId = crypto.randomUUID();
    currentMessageId = newMessageId;
    text = "";
    toolCalls = [];
    toolStatuses = {};
    updateRunState((draft) => {
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          s.iteration = turn;
          s.status = "calling-llm";
          s.toolCalls = [];
          s.currentToolIndex = 0;
        },
      });
      draft.chatMessageById[newMessageId] = {
        id: newMessageId,
        conversationId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        metadata: null,
      };
      const ids = draft.chatMessageIdsByConversationId[conversationId] ?? [];
      ids.push(newMessageId);
      draft.chatMessageIdsByConversationId[conversationId] = ids;
      draft.streamingMessageById[newMessageId] = {
        toolCalls: [],
        reasoning: "",
        isStreaming: true,
      };
    });
  };

  const beginAction = (callId: string, action: ComputerUseAction) => {
    const classification = classifyComputerUseAction(action);
    const toolName = toolNameFor(action);
    actionByCallId.set(callId, action);
    toolCalls = [
      ...toolCalls,
      {
        id: callId,
        name: toolName,
        arguments: JSON.stringify(classification.summary),
      },
    ];
    toolStatuses = { ...toolStatuses, [callId]: "pending" };
    updateRunState((draft) => {
      if (currentMessageId) {
        const streaming = draft.streamingMessageById[currentMessageId];
        if (streaming) {
          streaming.isStreaming = false;
          streaming.toolCalls.push({
            toolCallId: callId,
            toolName,
            done: false,
          });
        }
      }
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          s.status = "processing-tools";
          s.currentToolIndex = s.toolCalls.length;
          s.toolCalls.push({
            toolCallId: callId,
            toolName,
            params: { summary: classification.summary },
            // Left unset here on purpose. The approval flow mints the id and
            // hands it back with the answer, which is the only place it exists.
            // A guessed id finds no matching permission later, so a refusal
            // would read as a failure.
            status: needsComputerUseApproval(action)
              ? "awaiting-permission"
              : "executing",
          });
        },
      });
    });
  };

  const endAction = (
    callId: string,
    result: { success: boolean; skipped?: boolean; message: string },
    permissionId?: string,
  ) => {
    actionByCallId.delete(callId);
    // A refusal has to survive into the PERSISTED status, not only the live run
    // state. The run state is torn down when the run ends, so a refusal written
    // only there is a red "failed" in the chat history afterwards. This is the
    // same lookup `completedToolStatus` performs for the tool-calling run.
    const refusal =
      result.skipped === true ||
      isRefusal(conversationId, callId, permissionId);
    toolStatuses = {
      ...toolStatuses,
      [callId]: result.success ? "complete" : refusal ? "denied" : "failed",
    };
    updateRunState((draft) => {
      if (currentMessageId) {
        const streaming = draft.streamingMessageById[currentMessageId];
        const entry = streaming?.toolCalls.find(
          (call) => call.toolCallId === callId,
        );
        if (entry) entry.done = true;
      }
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          const call = s.toolCalls.find((entry) => entry.toolCallId === callId);
          if (!call) return;
          if (permissionId) call.permissionId = permissionId;
          // A refusal is not a failure. The action did not run because the user
          // said no, and painting that red teaches them that allowing is what
          // makes it stop happening.
          call.status = refusal ? "denied" : result.success ? "done" : "failed";
          call.result = { message: result.message };
        },
      });
    });
  };

  try {
    // The `finally` is the whole of the loop's lifetime management: it runs
    // when the consumer breaks out above, when the generator ends, and when
    // this function throws, so the loop is never left running after the
    // conversation stops listening to it.
    for await (const event of loop.run(signal)) {
      // A superseding run replaces this run's entry in the same state both
      // runners publish to. Once it does, this run no longer owns the
      // conversation, and applying another event would drive the screen on
      // behalf of a run the user already replaced.
      if (!isCurrent()) break;
      switch (event.type) {
        case "turn-start": {
          await startTurn(event.turn);
          break;
        }
        case "text": {
          text += event.text;
          updateRunState((draft) => {
            if (currentMessageId) {
              const message = draft.chatMessageById[currentMessageId];
              if (message) message.content += event.text;
            }
          });
          break;
        }
        case "action": {
          beginAction(event.callId, event.action);
          break;
        }
        case "action-result": {
          endAction(event.result.callId, event.result, event.permissionId);
          break;
        }
        case "finish": {
          // `max-turns` and `stuck` arrive with a sentence explaining why the
          // run stopped. The run state is torn down when the run ends, so that
          // sentence has to reach the persisted message to survive. Without
          // this the chat shows an empty bubble and the only trace of the
          // reason is a log line.
          if (event.reason !== "done" && event.message && !text) {
            text = event.message;
            updateRunState((draft) => {
              if (currentMessageId) {
                const message = draft.chatMessageById[currentMessageId];
                if (message) message.content += event.message!;
              }
            });
          }
          await persistCurrentMessage(
            "computer-use.finish",
            persistedOutcome(event.reason),
          );
          updateRunState((draft) => {
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                if (event.reason === "error") {
                  s.status = "error";
                  s.error = event.message ?? "The run failed.";
                  return;
                }
                s.status = "done";
                // `max-turns` and `stuck` arrive with a sentence explaining
                // why the run stopped. Keeping it as the run's message means
                // the chat shows the reason without inventing an error state
                // for something that completed.
                s.error = event.reason === "done" ? undefined : event.message;
              },
            });
          });
          break;
        }
      }
    }
  } catch (error) {
    // The loop is written to yield a finish event rather than throw, so this
    // only fires if the adapter or this consumer itself breaks. It still has to
    // land in state the user can see rather than an unhandled rejection.
    log.error(`Computer use run failed: ${String(error)}`);
    // The failure has to be readable, and a throw before the first turn leaves
    // no message to carry it. Writing one is what stops an adapter crash from
    // looking exactly like the agent doing nothing.
    if (!currentMessageId) {
      await startTurn(1);
    }
    if (!text) {
      text = "The computer use run stopped unexpectedly.";
      updateRunState((draft) => {
        const messageId = currentMessageId;
        if (!messageId) return;
        const message = draft.chatMessageById[messageId];
        if (message) message.content = text;
      });
    }
    await persistCurrentMessage("computer-use.error", "error");
    updateRunState((draft) => {
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          s.status = "error";
          s.error = "The computer use run stopped unexpectedly.";
        },
      });
    });
  } finally {
    if (loop.isRunning) loop.abort();
    // This runner drives the loop itself rather than going through
    // `runComputerUse`, so it owns the deregistration. Left behind, a finished
    // loop keeps answering `abort()` for a later run and cancels the wrong one.
    releaseComputerUseLoop(conversationId, loop);
    const finishedMessageId = currentMessageId;
    if (finishedMessageId) {
      produceAppState((draft) => {
        delete draft.streamingMessageById[finishedMessageId];
        // A run that lost ownership never reaches `persistCurrentMessage`, so
        // without this the half-written bubble stays in the conversation for
        // the rest of the session: visible, empty, and undeletable by the user.
        if (state() === undefined) {
          delete draft.chatMessageById[finishedMessageId];
          draft.chatMessageIdsByConversationId[conversationId] = (
            draft.chatMessageIdsByConversationId[conversationId] ?? []
          ).filter((id) => id !== finishedMessageId);
        }
      });
    }
    // Cleaned up on OUR identity, not on `isCurrent()`. An aborted run is by
    // definition not current, so gating the delete on it would leave the entry
    // in place forever after a stop: the conversation would report itself as
    // running, the Stop button would have nothing to abort, and a resend or
    // delete guard would refuse the conversation for the rest of the session.
    // A superseded run's entry carries a different agent type, so this cannot
    // tear down the newer run's state.
    if (state() !== undefined) {
      produceAppState((draft) => {
        delete draft.agentStateByConversationId[conversationId];
      });
    }
  }
}

/**
 * Whether an action stopped because the user said no, rather than because it
 * failed.
 *
 * Two signals, either of which is conclusive. The executor marks a refused
 * action as skipped, and the permission store records the verdict under the id
 * the approval flow minted. The store is the authority: it is the only record
 * that anyone agreed to anything, and a run that was superseded may not have
 * reached the executor at all.
 */
function isRefusal(
  conversationId: string,
  callId: string,
  permissionId: string | undefined,
): boolean {
  const state = getAppState();
  const recordedId =
    permissionId ??
    state.agentStateByConversationId[conversationId]?.toolCalls.find(
      (entry) => entry.toolCallId === callId,
    )?.permissionId;
  if (!recordedId) return false;
  return state.toolPermissionById?.[recordedId]?.status === "denied";
}

/**
 * Stop the conversation's computer-use run and mark its state aborted, so an
 * in-flight approval resolves as denied rather than waiting out its timeout.
 */
export function abortComputerUseRun(conversationId: string): void {
  produceAppState((draft) => {
    modifyAgentState({
      draft,
      conversationId,
      modify: (s) => {
        s.aborted = true;
      },
    });
  });
}
