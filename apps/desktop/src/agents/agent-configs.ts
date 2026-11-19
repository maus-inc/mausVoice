import type { ToolInfo } from "@maus-inc/types";
import { getAppState } from "../store";
import { normalizeAgentMaxIterations } from "../repos/preferences.repo";
import { getToolRegistryEntry } from "../tools";
import { HUMANIZE_SKILL_TEXT } from "../utils/humanize.utils";

export type AgentTypeConfig = {
  agentType: string;
  systemPrompt: string;
  getToolFilter: (conversationId: string) => (info: ToolInfo) => boolean;
  maxIterations: number;
};

const getConfiguredMaxIterations = (): number =>
  normalizeAgentMaxIterations(getAppState().userPrefs?.agentMaxIterations);

const getRegistryEnablement = (toolId: string): boolean => {
  const configured = getAppState().userPrefs?.agentEnabledTools;
  // Contract for `agentEnabledTools`:
  //   - `null` / undefined  -> follow the tool registry's per-tool default (enabled).
  //   - `[]`                -> explicit deny-all the user chose; never re-enable.
  //   - `[ids]`             -> explicit allow-set.
  // The empty-list branch intentionally does NOT fall back to "all enabled",
  // so an explicit deny-all can never be silently overridden by a migration.
  return configured === null || configured === undefined
    ? true
    : configured.includes(toolId);
};

export const CHAT_AGENT_CONFIG: AgentTypeConfig = {
  agentType: "chat",
  systemPrompt: [
    "You are a helpful assistant running on the user's desktop with access to tools.",
    "Use the available tools when needed to help the user.",
    "When the user refers to something on their screen, read the context using your tools — don't ask them to paste it.",
    "After completing a task, deliver the result using the appropriate tool (e.g. paste text into their field) and respond concisely.",
    "Iteratively solve larger tasks, break them down into smaller steps and use your tools to complete each step, delivering results as you go.",
    // A19: load the shared humanize skill so agent output is slop-free at the
    // source (the post-hoc scrubber in run-agent.ts is the safety net).
    HUMANIZE_SKILL_TEXT,
  ].join(" "),
  getToolFilter: (conversationId) => {
    const isPill = getAppState().pillConversationId === conversationId;
    return (tool) => {
      const registryEntry = getToolRegistryEntry(tool.id);
      if (!registryEntry) return false;
      const scope = tool.scope ?? registryEntry.scope;
      const inScope = isPill ? scope !== "chat" : scope !== "pill";
      return inScope && getRegistryEnablement(tool.id);
    };
  },
  get maxIterations() {
    return getConfiguredMaxIterations();
  },
};

/** Registry-backed configs leave room for specialized agents without adding
 * another switch statement in the run loop. */
export const AGENT_TYPE_CONFIGS: Readonly<Record<string, AgentTypeConfig>> = {
  chat: CHAT_AGENT_CONFIG,
};

export const getAgentTypeConfig = (agentType = "chat"): AgentTypeConfig =>
  AGENT_TYPE_CONFIGS[agentType] ?? CHAT_AGENT_CONFIG;
