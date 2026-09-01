export type ConnectorStatus =
  "connected" | "disconnected" | "syncing" | "error";

export type ConnectorType =
  "notion" | "slack" | "linear" | "jira" | "github" | "custom";

export type Connector = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  type: ConnectorType;
  name: string;
  status: ConnectorStatus;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  isDeleted: boolean;
};

export type ConnectorCredential = {
  id: string;
  connectorId: string;
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
};
