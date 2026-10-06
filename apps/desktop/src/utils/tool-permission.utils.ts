import { TOOL_RISK, type ToolRisk, type ToolRiskPolicy } from "@maus-inc/types";
import { getLocalStorage } from "./local-storage.utils";

const TOOL_ALWAYS_ALLOW_PREFIX = "tool_always_allow:";

/**
 * The risk tier a pending permission was raised at, or null when it carries
 * none.
 *
 * The tier travels in `params` rather than on `ToolPermission` because that
 * shape is part of the persisted permission contract and a field cannot be
 * dropped from it without a migration.
 *
 * A permission with no `risk` at all reads as null. That is every permission
 * raised before tool risk existed, and the prompt then behaves exactly as it
 * did then, so an old record is neither upgraded nor downgraded.
 *
 * A permission whose `risk` is present but unrecognisable is a different case,
 * and it reads as `critical`. Some value is claiming a tier and the code cannot
 * understand it, which means the record is not one this build wrote. Guessing
 * low there would hand an action the prompt cannot describe a standing grant,
 * and the consequence of being wrong runs the wrong way. Treating it as the most
 * consequential tier only makes the prompt stricter, which is the recoverable
 * direction.
 */
export const readPermissionRisk = (
  params: Record<string, unknown>,
): ToolRisk | null => {
  const risk = params.risk;
  if (risk === undefined) return null;
  // `in` walks the prototype chain, so `constructor`, `toString` and
  // `__proto__` would all read as tiers and each renders as a low-friction
  // prompt offering a standing grant. Own properties only.
  return typeof risk === "string" && Object.hasOwn(TOOL_RISK, risk)
    ? (risk as ToolRisk)
    : "critical";
};

/**
 * What the prompt should do for one permission.
 *
 * `null` means the permission carries no tier at all, so the prompt behaves
 * exactly as it did before tool risk existed. See {@link readPermissionRisk} for
 * why a present but unreadable tier does not land here too.
 */
export const permissionPromptPolicy = (
  params: Record<string, unknown>,
): ToolRiskPolicy | null => {
  const risk = readPermissionRisk(params);
  return risk === null ? null : TOOL_RISK[risk];
};

/**
 * The scope an "Always allow" grant is stored under.
 *
 * Only tools listed in {@link ACTION_SCOPED_TOOL_PREFIXES} are stored here.
 * Computer use asks the same question about "click at a point" once per turn,
 * so a grant that dies with the conversation asks again every turn. But a grant
 * at this scope outlives the conversation and the restart, and the existing
 * chat tools already have a working conversation-scoped grant. Widening those
 * silently would hand `run_terminal_command`, which is rated high, a permanent
 * global exemption with no way to take it back, which is a change to the
 * shipping permission flow rather than a new feature.
 */
export const TOOL_ALWAYS_ALLOW_ACTION_SCOPE = "action";

/** Tool id prefixes whose always-allow grant is action-scoped. */
export const ACTION_SCOPED_TOOL_PREFIXES: readonly string[] = ["computer_use:"];

const isActionScoped = (toolId: string): boolean =>
  ACTION_SCOPED_TOOL_PREFIXES.some((prefix) => toolId.startsWith(prefix));

/**
 * Always-allow decisions are scoped rather than one global switch. Existing
 * keys remain valid as the global scope for backwards compatibility.
 */
export const getToolAlwaysAllow = (
  toolId: string,
  scope = "global",
): boolean => {
  const storage = getLocalStorage();
  if (!storage) return false;
  const read = (key: string): boolean => storage.getItem(key) === "true";
  return (
    read(`${TOOL_ALWAYS_ALLOW_PREFIX}${scope}:${toolId}`) ||
    (isActionScoped(toolId) &&
      read(
        `${TOOL_ALWAYS_ALLOW_PREFIX}${TOOL_ALWAYS_ALLOW_ACTION_SCOPE}:${toolId}`,
      )) ||
    read(`${TOOL_ALWAYS_ALLOW_PREFIX}global:${toolId}`) ||
    // Legacy unscoped keys, written before grants had any scope at all.
    read(`${TOOL_ALWAYS_ALLOW_PREFIX}${toolId}`)
  );
};

/**
 * Record an always-allow grant.
 *
 * Granting writes the scope it was asked for. An action-scoped tool also gets
 * the action scope, so a computer-use grant survives the conversation. Revoking
 * drops every scope that names this tool rather than only the one passed in: a
 * revoke that leaves the action grant behind would report that the tool is no
 * longer always allowed while still executing without asking.
 */
export const setToolAlwaysAllow = (
  toolId: string,
  allowed: boolean,
  scope = "global",
): void => {
  const storage = getLocalStorage();
  if (!storage) return;
  if (allowed) {
    if (isActionScoped(toolId) && scope !== TOOL_ALWAYS_ALLOW_ACTION_SCOPE) {
      storage.setItem(
        `${TOOL_ALWAYS_ALLOW_PREFIX}${TOOL_ALWAYS_ALLOW_ACTION_SCOPE}:${toolId}`,
        "true",
      );
    }
    storage.setItem(`${TOOL_ALWAYS_ALLOW_PREFIX}${scope}:${toolId}`, "true");
    return;
  }

  storage.removeItem(`${TOOL_ALWAYS_ALLOW_PREFIX}${scope}:${toolId}`);
  storage.removeItem(
    `${TOOL_ALWAYS_ALLOW_PREFIX}${TOOL_ALWAYS_ALLOW_ACTION_SCOPE}:${toolId}`,
  );
  storage.removeItem(`${TOOL_ALWAYS_ALLOW_PREFIX}global:${toolId}`);
  // Legacy unscoped keys predate per-conversation grants. Always drop
  // them on revoke so a leftover `tool_always_allow:<id>` cannot keep
  // auto-executing after the new scoped path says no.
  storage.removeItem(`${TOOL_ALWAYS_ALLOW_PREFIX}${toolId}`);
};
