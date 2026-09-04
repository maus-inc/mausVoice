export type WorkflowTriggerType =
  "voice_command" | "hotkey" | "event" | "schedule";

export type WorkflowStatus =
  "idle" | "running" | "completed" | "failed" | "cancelled";

export type Workflow = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  name: string;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  actions: WorkflowAction[];
  enabled: boolean;
  isDeleted: boolean;
};

export type WorkflowAction = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  order: number;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  triggerContext: Record<string, unknown> | null;
};
