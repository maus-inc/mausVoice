import { Nullable } from "./common.types";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessageRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  metadata: Nullable<Record<string, unknown>>;
};

export type ChatToolStatus =
  "pending" | "approval" | "running" | "complete" | "denied" | "failed";

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; open: boolean }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      status: ChatToolStatus;
      reason?: string;
    }
  | {
      kind: "tool-result";
      toolCallId: string;
      toolName: string;
      reason?: string;
    }
  | { kind: "permission"; permissionId: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };
