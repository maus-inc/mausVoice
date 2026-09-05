import { AgentLoop } from "@repo/agent";
import type { AgentLlmProvider, AgentTool } from "@repo/agent";
import type { LlmMessage, LlmToolCall, ToolInfo } from "@maus-inc/types";
import {
  delayed,
  isLogBreakingControl,
  unknownToMessage,
} from "@maus-inc/utilities";
import { createChatMessage } from "../actions/chat.actions";
import {
  executeTool,
  getToolPermissionStatus,
  requestToolPermission,
} from "../actions/tool.actions";
import { getAgentRepo, getChatMessageRepo } from "../repos";
import { createAgentRunState } from "../state/agent.state";
import { getAppState, produceAppState } from "../store";
import { createTool } from "../tools";
import { modifyAgentState } from "../utils/agent.utils";
import { getLogger } from "../utils/log.utils";
import { humanizeScrub } from "../utils/humanize.utils";
import type { AgentTypeConfig } from "./agent-configs";

const POLL_INTERVAL_MS = 500;
const MAX_CONTEXT_MESSAGES = 80;
const activeLoops = new Map<string, AgentLoop>();

/**
 * Run a non-critical side effect inside the agent's `for await` loop and
 * isolate any rejection. A failing chat-message persistence, streaming-state
 * write, or tool-UI update must NEVER terminate the agent run: the
 * in-memory `AgentLoop` already has the tool result and the next LLM
 * request must be issued. The "resource id is invalid" log the user saw
 * in the diagnostics zip was an unhandled rejection from this exact
 * surface; wrapping the call keeps the loop alive.
 *
 * `label` is included in the log so post-mortem inspection can map a
 * failure back to a specific event handler. Context values are collapsed
 * to a single line, truncated, and JSON-quoted so ids stay parseable
 * without breaking the log line.
 */
const MAX_CONTEXT_VALUE_LENGTH = 64;

const collapseLogBreakingControls = (value: string): string =>
  Array.from(value, (ch) => (isLogBreakingControl(ch) ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();

/** Collapse C0 and C1 control characters so a multi-line or binary-ish value cannot break the log line. */
const sanitizeContextValue = (value: string): string => {
  const singleLine = collapseLogBreakingControls(value);
  return singleLine.length > MAX_CONTEXT_VALUE_LENGTH
    ? `${singleLine.slice(0, MAX_CONTEXT_VALUE_LENGTH)}…`
    : singleLine;
};

/** Log parsers must treat each value as a JSON string, not a comma-split field. */
const quoteValueForLog = (value: string): string =>
  JSON.stringify(sanitizeContextValue(value));

const summarizeContext = (context: Record<string, string>): string =>
  Object.entries(context)
    .map(([k, v]) => `${k}=${quoteValueForLog(v)}`)
    .join(", ");

export async function safeSideEffect<T>(
  label: string,
  context: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = JSON.stringify(
      collapseLogBreakingControls(unknownToMessage(error)),
    );
    getLogger().error(
      `Agent non-critical side effect failed (${label}, ${summarizeContext(
        context,
      )}): ${message}`,
    );
    return null;
  }
}

/**
 * Drive one agent conversation to completion on the desktop adapter.
 * Emits every AgentLoop event into app state; non-critical persistence
 * failures are logged via safeSideEffect so they do not terminate loop
 * processing.
 */
export async function runAgent(
  conversationId: string,
  config: AgentTypeConfig,
): Promise<void> {
  const agentState = createAgentRunState(
    config.agentType,
    config.maxIterations,
  );
  produceAppState((draft) => {
    draft.agentStateByConversationId[conversationId] = agentState;
  });

  const provider = createLlmProvider();
  const tools = createAgentTools(conversationId, config);
  const messages = buildConversationMessages(conversationId);

  const loop = new AgentLoop({
    provider,
    tools,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
  });

  activeLoops.set(conversationId, loop);

  let currentMessageId: string | null = null;
  let iterationText = "";
  let iterationToolCalls: LlmToolCall[] = [];
  let toolCallIndex = 0;
  const toolCallReasons = new Map<string, string>();

  try {
    for await (const event of loop.run(messages)) {
      switch (event.type) {
        case "iteration-start": {
          const previousMessageId = currentMessageId;
          if (previousMessageId) {
            await safeSideEffect(
              "iteration-start.finalizePrevious",
              { conversationId, messageId: previousMessageId },
              () =>
                finalizeAssistantMessage(
                  previousMessageId,
                  iterationText,
                  iterationToolCalls,
                ),
            );
          }

          const newMessageId = crypto.randomUUID();
          currentMessageId = newMessageId;
          iterationText = "";
          iterationToolCalls = [];
          toolCallIndex = 0;

          produceAppState((draft) => {
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.iteration = event.iteration;
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
            const ids =
              draft.chatMessageIdsByConversationId[conversationId] ?? [];
            ids.push(newMessageId);
            draft.chatMessageIdsByConversationId[conversationId] = ids;

            draft.streamingMessageById[newMessageId] = {
              toolCalls: [],
              reasoning: "",
              isStreaming: true,
            };
          });
          break;
        }

        case "text-delta": {
          iterationText += event.text;
          produceAppState((draft) => {
            if (currentMessageId) {
              const msg = draft.chatMessageById[currentMessageId];
              if (msg) msg.content += event.text;
            }
          });
          break;
        }

        case "tool-call-start": {
          iterationToolCalls.push({
            id: event.toolCallId,
            name: event.toolName,
            arguments: JSON.stringify(event.args),
          });
          if (event.args.reason) {
            toolCallReasons.set(event.toolCallId, event.args.reason as string);
          }
          produceAppState((draft) => {
            if (currentMessageId) {
              const streaming = draft.streamingMessageById[currentMessageId];
              if (streaming) {
                streaming.isStreaming = false;
                streaming.toolCalls.push({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  done: false,
                });
              }
            }
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.status = "processing-tools";
                s.currentToolIndex = toolCallIndex;
                s.toolCalls.push({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  params: event.args,
                  status: "pending",
                });
              },
            });
          });
          break;
        }

        case "tool-call-result": {
          toolCallIndex++;
          const reason = toolCallReasons.get(event.toolCallId);
          // Persist the tool result as a "system" ChatMessageRole (the
          // persistence layer has no "tool" role) and tag it with
          // metadata.type so the load path can rehydrate it as an
          // LlmMessage `tool` correlated to event.toolCallId.
          //
          // The persist call is wrapped in `safeSideEffect` because a
          // rejected write (for example, the "resource id is invalid"
          // error captured in the user's diagnostics zip) would otherwise
          // escape the `for await` loop and prevent the next model
          // iteration. The in-memory `AgentLoop` has already appended
          // the tool result to its history; failing to persist it must
          // not stop the agent.
          await safeSideEffect(
            "tool-call-result.persist",
            {
              conversationId,
              toolCallId: event.toolCallId,
            },
            () =>
              createChatMessage({
                id: crypto.randomUUID(),
                conversationId,
                role: "system",
                content: event.result,
                createdAt: new Date().toISOString(),
                metadata: {
                  type: "tool-result",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  ...(reason && { reason }),
                },
              }),
          );
          produceAppState((draft) => {
            if (currentMessageId) {
              const streaming = draft.streamingMessageById[currentMessageId];
              if (streaming) {
                const tc = streaming.toolCalls.find(
                  (t) => t.toolCallId === event.toolCallId,
                );
                if (tc) tc.done = true;
              }
            }
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                const tc = s.toolCalls.find(
                  (t) => t.toolCallId === event.toolCallId,
                );
                if (tc) {
                  tc.status = event.isError ? "denied" : "done";
                  tc.result = { text: event.result };
                }
              },
            });
          });

          if (event.toolName === "end_conversation") {
            loop.abort();
          }
          break;
        }

        case "finish": {
          const finishingMessageId = currentMessageId;
          if (finishingMessageId) {
            await safeSideEffect(
              "finish.finalize",
              { conversationId, messageId: finishingMessageId },
              () =>
                finalizeAssistantMessage(
                  finishingMessageId,
                  iterationText,
                  iterationToolCalls,
                ),
            );
          }
          produceAppState((draft) => {
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.status = event.reason === "error" ? "error" : "done";
                if (event.error) s.error = event.error;
              },
            });
          });
          break;
        }
      }
    }
  } catch (error) {
    getLogger().error("Agent error", error);
    produceAppState((draft) => {
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          s.status = "error";
          s.error = String(error);
        },
      });
    });
  } finally {
    const finishedMessageId = currentMessageId;
    if (finishedMessageId) {
      produceAppState((draft) => {
        delete draft.streamingMessageById[finishedMessageId];
      });
    }
    activeLoops.delete(conversationId);
  }
}

/**
 * Abort the live agent loop for a conversation and mark its state
 * aborted so any in-flight permission polling resolves as denied.
 */
export function abortAgentLoop(conversationId: string): void {
  const loop = activeLoops.get(conversationId);
  if (loop) loop.abort();

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

/**
 * Persist the finished assistant message with scrubbed content and
 * retire its streaming entry, regardless of persistence outcome.
 */
async function finalizeAssistantMessage(
  messageId: string,
  text: string,
  toolCalls: LlmToolCall[],
): Promise<void> {
  const message = getAppState().chatMessageById[messageId];
  if (!message) return;

  // A19: Apply the humanize scrubber to remove AI-slop markers from the
  // final assistant output before persisting and displaying it.
  const cleaned = text ? humanizeScrub(text) : "";
  const final = {
    ...message,
    content: cleaned,
    metadata:
      toolCalls.length > 0
        ? ({ type: "reasoning", toolCalls } as Record<string, unknown>)
        : null,
  };

  // Retire the streaming entry regardless of the persistence outcome.
  // safeSideEffect swallows rejections from this function so the agent
  // loop survives (the whole point of the wrapper); without the finally,
  // a failed createChatMessage would leave the message stuck in
  // streamingMessageById forever as an indefinitely-streaming bubble.
  // On failure the in-memory copy still gets the scrubbed final text so
  // the conversation view stays coherent for the session; only the
  // durable history row is missing, and that is what the log records.
  try {
    await getChatMessageRepo().createChatMessage(final);
  } finally {
    produceAppState((draft) => {
      draft.chatMessageById[messageId] = final;
      delete draft.streamingMessageById[messageId];
    });
  }
}

/** Build the AgentLlmProvider that proxies streaming through the repo. */
function createLlmProvider(): AgentLlmProvider {
  const { repo } = getAgentRepo();
  if (!repo) throw new Error("No LLM provider configured");
  return {
    async *streamChat(input) {
      yield* repo.streamChat(input);
    },
  };
}

function createAgentTools(
  conversationId: string,
  config: AgentTypeConfig,
): AgentTool[] {
  const state = getAppState();
  const toolFilter = config.getToolFilter(conversationId);
  const toolInfos = Object.values(state.toolInfoById).filter(toolFilter);

  return toolInfos.map((info) => ({
    name: info.id,
    description: `${info.description}. ${info.instructions}`,
    parameters: info.schema,
    async execute({ params, reason }) {
      return executeWithPermission(info, params, reason, conversationId);
    },
  }));
}

async function executeWithPermission(
  info: ToolInfo,
  params: Record<string, unknown>,
  reason: string,
  conversationId: string,
) {
  const tool = createTool(info);
  const permissionScope = `conversation:${conversationId}`;

  if (tool.getAlwaysAllow(params, permissionScope)) {
    try {
      const result = await executeTool(info.id, params);
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const permissionParams = { ...params, reason };
  const permissionId = requestToolPermission(
    info.id,
    permissionParams,
    conversationId,
  );

  produceAppState((draft) => {
    modifyAgentState({
      draft,
      conversationId,
      modify: (s) => {
        const tc = s.toolCalls[s.toolCalls.length - 1];
        if (tc) {
          tc.permissionId = permissionId;
          tc.status = "awaiting-permission";
        }
      },
    });
  });

  const resolution = await pollForPermission(conversationId, permissionId);

  if (resolution === "allowed") {
    try {
      const result = await executeTool(info.id, params);
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: false, failureReason: "Tool call was denied by user" };
}

/**
 * Poll app state until the user resolves a tool permission request,
 * or return denied when the conversation is aborted first.
 */
async function pollForPermission(
  conversationId: string,
  permissionId: string,
): Promise<"allowed" | "denied"> {
  while (true) {
    const state = getAppState().agentStateByConversationId[conversationId];
    if (state?.aborted) return "denied";

    const result = getToolPermissionStatus(permissionId);
    if (result?.status === "allowed") return "allowed";
    if (result?.status === "denied") return "denied";
    await delayed(POLL_INTERVAL_MS);
  }
}

type ConversationMessageBlock = {
  startIndex: number;
  messages: LlmMessage[];
};

type ResolvedConversationBlock = ConversationMessageBlock & {
  nextIndex: number;
};

const isValidPersistedToolCall = (value: unknown): value is LlmToolCall => {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return (
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0 &&
    typeof call.arguments === "string"
  );
};

const textOnlyAssistantMessage = (
  message: Extract<LlmMessage, { role: "assistant" }>,
): LlmMessage => ({
  role: "assistant",
  content: message.content || undefined,
});

/**
 * Resolve one assistant message and its following tool results as one block.
 * Providers require each tool call to have a matching result in the same
 * request; a positional slice can otherwise start with an orphaned result or
 * end after the assistant tool-call message.
 */
const resolveConversationBlock = (
  messages: LlmMessage[],
  startIndex: number,
): ResolvedConversationBlock => {
  const message = messages[startIndex];
  if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) {
    return { startIndex, messages: [message], nextIndex: startIndex + 1 };
  }

  const hasValidToolCalls =
    message.toolCalls.length > 0 &&
    message.toolCalls.every(isValidPersistedToolCall);
  if (!hasValidToolCalls) {
    return {
      startIndex,
      messages: [textOnlyAssistantMessage(message)],
      nextIndex: startIndex + 1,
    };
  }

  const callIds = message.toolCalls.map((call) => call.id);
  if (new Set(callIds).size !== callIds.length) {
    return {
      startIndex,
      messages: [textOnlyAssistantMessage(message)],
      nextIndex: startIndex + 1,
    };
  }

  const expected = new Set(callIds);
  const toolResults: LlmMessage[] = [];
  const seen = new Set<string>();
  let nextIndex = startIndex + 1;
  while (nextIndex < messages.length) {
    const next = messages[nextIndex];
    if (next.role !== "tool" || !expected.has(next.toolCallId)) break;
    if (seen.has(next.toolCallId)) break;
    seen.add(next.toolCallId);
    toolResults.push(next);
    nextIndex += 1;
  }

  if (seen.size === expected.size) {
    return {
      startIndex,
      messages: [message, ...toolResults],
      nextIndex,
    };
  }

  // A persisted conversation can be interrupted between the assistant
  // response and a tool result. Keep its text, but strip incomplete tool
  // calls rather than sending an invalid partial exchange.
  return {
    startIndex,
    messages: [textOnlyAssistantMessage(message)],
    nextIndex: startIndex + 1,
  };
};

const groupConversationMessages = (
  messages: LlmMessage[],
): ConversationMessageBlock[] => {
  const blocks: ConversationMessageBlock[] = [];
  let index = 0;

  while (index < messages.length) {
    if (messages[index].role === "tool") {
      index += 1;
      continue;
    }

    const block = resolveConversationBlock(messages, index);
    blocks.push({ startIndex: block.startIndex, messages: block.messages });
    index = block.nextIndex;
  }

  return blocks;
};

const trimConversationBlocks = (
  blocks: ConversationMessageBlock[],
): LlmMessage[] => {
  const totalMessages = blocks.reduce(
    (total, block) => total + block.messages.length,
    0,
  );
  if (totalMessages <= MAX_CONTEXT_MESSAGES) {
    return blocks.flatMap((block) => block.messages);
  }

  const selected = new Set<number>();
  let remaining = MAX_CONTEXT_MESSAGES;
  const firstUserIndex = blocks.findIndex((block) =>
    block.messages.some((message) => message.role === "user"),
  );

  if (firstUserIndex >= 0) {
    const firstUserBlock = blocks[firstUserIndex];
    selected.add(firstUserIndex);
    remaining -= firstUserBlock.messages.length;
  }

  let selectedRecentBlock = false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (selected.has(index)) continue;
    const blockSize = blocks[index].messages.length;
    if (blockSize > remaining) continue;
    selected.add(index);
    selectedRecentBlock = true;
    remaining -= blockSize;
    if (remaining === 0) break;
  }

  // Keep at least the newest complete block when a future block is larger
  // than the nominal budget or none of the recent blocks fit. This preserves
  // protocol validity over a strict message count.
  const newestIndex = blocks.length - 1;
  if (!selectedRecentBlock && newestIndex >= 0 && !selected.has(newestIndex)) {
    selected.add(newestIndex);
  }

  return blocks
    .filter((_, index) => selected.has(index))
    .sort((left, right) => left.startIndex - right.startIndex)
    .flatMap((block) => block.messages);
};

function buildConversationMessages(conversationId: string): LlmMessage[] {
  const state = getAppState();
  const messageIds = state.chatMessageIdsByConversationId[conversationId] ?? [];
  const messages: LlmMessage[] = [];

  for (const id of messageIds) {
    const msg = state.chatMessageById[id];
    if (!msg) continue;

    const metadata = msg.metadata as Record<string, unknown> | null;

    // Tool results are persisted with role "system" plus metadata.type
    // (see the tool-call-result persist branch above). Rehydrate them
    // here as LlmMessage `tool` messages by matching the saved id.
    if (
      metadata?.type === "tool-result" &&
      typeof metadata.toolCallId === "string"
    ) {
      messages.push({
        role: "tool",
        toolCallId: metadata.toolCallId,
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const persistedToolCalls = metadata?.toolCalls;
      const toolCalls =
        Array.isArray(persistedToolCalls) &&
        persistedToolCalls.every(isValidPersistedToolCall)
          ? persistedToolCalls
          : undefined;
      messages.push({
        role: "assistant",
        content: msg.content || undefined,
        ...(toolCalls && { toolCalls }),
      });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    }
  }

  return trimConversationBlocks(groupConversationMessages(messages));
}
