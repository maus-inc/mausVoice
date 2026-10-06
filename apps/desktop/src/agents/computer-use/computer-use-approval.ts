import type { ComputerUseAction, ToolInfo } from "@maus-inc/types";
import {
  getToolPermissionStatus,
  requestToolPermission,
  resolveToolPermission,
} from "../../actions/tool.actions";
import { getToolAlwaysAllow } from "../../utils/tool-permission.utils";
import { registerToolInfos } from "../../utils/app.utils";
import { produceAppState } from "../../store";
import { getLogger } from "../../utils/log.utils";
import type {
  ComputerUseApprovalOutcome,
  ComputerUseApprovalRequest,
} from "./computer-use-loop";

const log = getLogger();

const POLL_INTERVAL_MS = 250;

/**
 * A permission id per action type, not per session.
 *
 * "Always allow" stores a grant under the tool id, so an id that named the whole
 * computer-use capability would hand over the mouse, the keyboard and the
 * clipboard in one click. Naming the action type instead means allowing clicks
 * still asks about typing.
 */
export const computerUseToolId = (action: ComputerUseAction): string =>
  `computer_use:${action.type}`;

/**
 * The prompt reads its heading from `toolInfoById`, so the plain-language
 * summary has to be registered there. Registering it per action type means two
 * different clicks describe themselves rather than reusing one stale sentence.
 */
const toolInfoFor = (request: ComputerUseApprovalRequest): ToolInfo => ({
  id: computerUseToolId(request.action),
  description: request.summary,
  instructions: request.summary,
  risk: request.risk,
  schema: { type: "object", properties: {} },
});

export type ComputerUseApprovalDeps = {
  conversationId: string;
  signal?: AbortSignal;
  /**
   * Whether the run has been told to stop.
   *
   * Production reaches a run through `loop.abort()`, not through an
   * `AbortSignal`, so a poll that only watched the signal stayed parked for
   * the whole permission timeout after Stop, and the run stayed registered as
   * live with its Stop button still on screen.
   */
  isStopped?: () => boolean;
};

/**
 * Ask the user about one action, through the permission store the rest of agent
 * mode already uses.
 *
 * This is why the existing permission UI keeps working unchanged. The prompt is a
 * `ToolPermission` like any other, so `ToolPermissionCard` renders it, its
 * "Always allow" writes a grant through `setToolAlwaysAllow` at both scopes, and
 * the 60 second timeout in `getToolPermissionStatus` still applies. A separate
 * dialog for computer use would have been a second permission system with a
 * second set of ways to run an action nobody approved.
 */
export const requestComputerUseApproval = async (
  request: ComputerUseApprovalRequest,
  deps: ComputerUseApprovalDeps,
): Promise<ComputerUseApprovalOutcome> => {
  const { conversationId, signal, isStopped } = deps;
  const stopped = () => signal?.aborted === true || isStopped?.() === true;
  const toolId = computerUseToolId(request.action);

  if (getToolAlwaysAllow(toolId, `conversation:${conversationId}`)) {
    return { answer: "always" };
  }

  if (stopped()) {
    return { answer: "deny" };
  }

  produceAppState((draft) => {
    registerToolInfos(draft, [toolInfoFor(request)]);
  });

  const permissionId = requestToolPermission(
    toolId,
    {
      reason: request.warning
        ? `${request.summary}. ${request.warning}`
        : request.summary,
      risk: request.risk,
      actionType: request.action.type,
    },
    conversationId,
  );
  log.verbose(`Asked the user to approve a ${request.action.type} action`);

  for (;;) {
    if (stopped()) {
      // Clear the card as well as returning. A pending prompt left on screen
      // invites an answer to a run that has already stopped, and a later Allow
      // would read as consent that was never acted on.
      resolveToolPermission(permissionId, "denied");
      return { answer: "deny", permissionId };
    }
    const status = getToolPermissionStatus(permissionId);
    if (!status) {
      // The permission was consumed or dropped. Reading that as a denial is the
      // safe direction: the alternative is running an action nobody agreed to.
      return { answer: "deny", permissionId };
    }
    if (status.status === "allowed") {
      return { answer: "approve", permissionId };
    }
    if (status.status === "denied") {
      return { answer: "deny", permissionId };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};
