import type { ToolInfo } from "@maus-inc/types";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../utils/tool-permission.utils";

export type ToolResult = Record<string, unknown>;

/**
 * Call-scoped data supplied by the agent that owns a tool invocation.
 * It must travel with the call rather than through global pill state: more
 * than one conversation can be active and a Chats-originated tool call has no
 * pill conversation to infer from.
 */
export type ToolExecutionContext = Readonly<{
  conversationId?: string;
}>;

export abstract class BaseTool {
  constructor(public readonly info: ToolInfo) {}

  abstract execute(
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult>;

  getAlwaysAllow(_params: Record<string, unknown>, scope = "global"): boolean {
    return getToolAlwaysAllow(this.info.id, scope);
  }

  setAlwaysAllow(
    _params: Record<string, unknown>,
    allowed: boolean,
    scope = "global",
  ): void {
    setToolAlwaysAllow(this.info.id, allowed, scope);
  }
}
