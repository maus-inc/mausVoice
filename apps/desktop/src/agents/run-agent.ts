import { AgentLoop } from "@repo/agent";
import type { AgentLlmProvider, AgentTool } from "@repo/agent";
import type { LlmMessage, LlmToolCall, ToolInfo } from "@maus-inc/types";
import { delayed } from "@maus-inc/utilities";
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
import type { AgentTypeConfig } from "./agent-configs";

const POLL_INTERVAL_MS = 500;
const MAX_CONTEXT_MESSAGES = 80;
const activeLoops = new Map<string, AgentLoop>();

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
          if (currentMessageId) {
            await finalizeAssistantMessage(
              currentMessageId,
              iterationText,
              iterationToolCalls,
            );
          }

          currentMessageId = crypto.randomUUID();
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

            draft.chatMessageById[currentMessageId!] = {
              id: currentMessageId!,
              conversationId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
              metadata: null,
            };
            const ids =
              draft.chatMessageIdsByConversationId[conversationId] ?? [];
            ids.push(currentMessageId!);
            draft.chatMessageIdsByConversationId[conversationId] = ids;

            draft.streamingMessageById[currentMessageId!] = {
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
          await createChatMessage({
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
          });
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
          if (currentMessageId) {
            await finalizeAssistantMessage(
              currentMessageId,
              iterationText,
              iterationToolCalls,
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
    if (currentMessageId) {
      produceAppState((draft) => {
        delete draft.streamingMessageById[currentMessageId!];
      });
    }
    activeLoops.delete(conversationId);
  }
}

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

async function finalizeAssistantMessage(
  messageId: string,
  text: string,
  toolCalls: LlmToolCall[],
): Promise<void> {
  const message = getAppState().chatMessageById[messageId];
  if (!message) return;

  const final = {
    ...message,
    content: text || "",
    metadata:
      toolCalls.length > 0
        ? ({ type: "reasoning", toolCalls } as Record<string, unknown>)
        : null,
  };

  await getChatMessageRepo().createChatMessage(final);

  produceAppState((draft) => {
    draft.chatMessageById[messageId] = final;
    delete draft.streamingMessageById[messageId];
  });
}

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

/**
 * Group assistant tool calls with all of their tool results before trimming.
 * Providers require each tool call to have a matching result in the same
 * request; a positional slice can otherwise start with an orphaned result or
 * end after the assistant tool-call message.
 */
const groupConversationMessages = (
  messages: LlmMessage[],
): ConversationMessageBlock[] => {
  const blocks: ConversationMessageBlock[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "tool") {
      // Orphaned tool results cannot be sent to an LLM provider safely.
      continue;
    }

    const toolCalls =
      message.role === "assistant" && Array.isArray(message.toolCalls)
        ? message.toolCalls
        : [];
    const callIds = toolCalls.map((call) => call.id);
    const hasValidToolCalls =
      callIds.length > 0 &&
      callIds.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(callIds).size === callIds.length;

    if (!hasValidToolCalls) {
      blocks.push({ startIndex: index, messages: [message] });
      continue;
    }

    const expected = new Set(callIds);
    const toolResults: LlmMessage[] = [];
    const seen = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const next = messages[nextIndex];
      if (next.role !== "tool" || !expected.has(next.toolCallId)) break;
      if (seen.has(next.toolCallId)) break;
      seen.add(next.toolCallId);
      toolResults.push(next);
      nextIndex++;
    }

    if (seen.size === expected.size) {
      blocks.push({
        startIndex: index,
        messages: [message, ...toolResults],
      });
      index = nextIndex - 1;
      continue;
    }

    // A persisted conversation can be interrupted between the assistant
    // response and a tool result. Keep its text, but strip incomplete tool
    // calls rather than sending an invalid partial exchange.
    blocks.push({
      startIndex: index,
      messages: [
        {
          role: "assistant",
          content: message.content || undefined,
        },
      ],
    });
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

  for (let index = blocks.length - 1; index >= 0; index--) {
    if (selected.has(index)) continue;
    const blockSize = blocks[index].messages.length;
    if (blockSize > remaining) continue;
    selected.add(index);
    remaining -= blockSize;
    if (remaining === 0) break;
  }

  // Keep at least the newest complete block when a future block is larger
  // than the nominal budget. This preserves protocol validity over a strict
  // message count, and normal agent iterations are bounded well below 80.
  if (selected.size === 0 && blocks.length > 0) {
    selected.add(blocks.length - 1);
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
      const toolCalls = Array.isArray(metadata?.toolCalls)
        ? (metadata.toolCalls as LlmToolCall[])
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
