import type { JSONSchema } from "./json-schema.types";

export type ToolScope = "pill" | "chat";

/**
 * How much damage a tool can do if it runs without being asked first.
 *
 * The tier decides whether the user is prompted, so it is a required field
 * rather than an optional hint. A tool that omits it cannot be registered,
 * which keeps an unrated tool from being quietly treated as safe.
 */
export type ToolRisk = "low" | "medium" | "high" | "critical";

export interface ToolInfo {
  id: string;
  description: string;
  instructions: string;
  schema: JSONSchema;
  scope?: ToolScope;
  /** Required. See `TOOL_RISK` for what each tier means for the user. */
  risk: ToolRisk;
}

/**
 * What each risk tier means for a desktop action, in one place.
 *
 * The permission flow reads this rather than hard-coding thresholds, so adding
 * a tier is a change here and nowhere else. `low` runs without asking because
 * there is nothing to undo; `critical` is the only tier that states the
 * consequence before the buttons rather than after.
 */
export const TOOL_RISK = {
  low: { prompt: false, requiresConfirmation: false, warnBeforeRunning: false },
  medium: { prompt: true, requiresConfirmation: false, warnBeforeRunning: false },
  high: { prompt: true, requiresConfirmation: true, warnBeforeRunning: false },
  critical: {
    prompt: true,
    requiresConfirmation: true,
    warnBeforeRunning: true,
  },
} as const satisfies Record<
  ToolRisk,
  {
    prompt: boolean;
    requiresConfirmation: boolean;
    warnBeforeRunning: boolean;
  }
>;

/** What the permission prompt does at one risk tier. */
export type ToolRiskPolicy = (typeof TOOL_RISK)[ToolRisk];

export type ToolPermissionStatus = "pending" | "allowed" | "denied";

export type ToolPermissionResolution = Extract<
  ToolPermissionStatus,
  "allowed" | "denied"
>;

export interface ToolPermission {
  id: string;
  toolId: string;
  params: Record<string, unknown>;
  status: ToolPermissionStatus;
  token?: string;
  conversationId: string;
  /** Links the request to its timeline step. Absent on pre-part requests. */
  toolCallId?: string;
  createdAt: number;
}
