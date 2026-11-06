import type { ToolPermissionResolution } from "@maus-inc/types";

export type OverlayPhase = "idle" | "recording" | "loading" | "paused";

export type OverlayResolvePermissionPayload = {
  permissionId: string;
  status: ToolPermissionResolution;
  alwaysAllow?: boolean;
};
