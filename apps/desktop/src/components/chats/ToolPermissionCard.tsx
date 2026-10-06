import type { ToolPermission } from "@maus-inc/types";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import { ToolPermissionPrompt } from "../common/ToolPermissionPrompt";

type ToolPermissionCardProps = {
  permission: ToolPermission;
};

export const ToolPermissionCard = ({ permission }: ToolPermissionCardProps) => {
  return (
    <ToolPermissionPrompt
      permission={permission}
      onAllow={() => resolveToolPermission(permission.id, "allowed")}
      onDeny={() => resolveToolPermission(permission.id, "denied")}
      onAlwaysAllow={() => {
        // `setToolAlwaysAllow` writes the conversation scope so the grant
        // applies immediately. A `computer_use:*` tool id also gets the action
        // scope, so the same question is not asked again in the next
        // conversation; the four registry tools get the conversation scope
        // alone, which is what they got before tiers existed.
        setToolAlwaysAllow({
          toolId: permission.toolId,
          params: permission.params,
          allowed: true,
          scope: `conversation:${permission.conversationId}`,
        });
        resolveToolPermission(permission.id, "allowed");
      }}
    />
  );
};
