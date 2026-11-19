export type WorkflowTriggerType =
  "voice_command" | "hotkey" | "event" | "schedule";

export type WorkflowStatus =
  "idle" | "running" | "completed" | "failed" | "cancelled";

export type WorkflowAction = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  order: number;
};

export type Workflow = {
  id: string;
  name: string;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  actions: WorkflowAction[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  triggerContext?: Record<string, unknown>;
};
