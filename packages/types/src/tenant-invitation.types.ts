import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import { Replace } from "./common.types";
import { TenantRole, TenantRoleZod } from "./tenant.types";

export const TENANT_INVITATION_STATUSES = [
  "pending",
  "accepted",
  "expired",
  "revoked",
] as const;
export type TenantInvitationStatus =
  (typeof TENANT_INVITATION_STATUSES)[number];
export const TenantInvitationStatusZod = z.enum(TENANT_INVITATION_STATUSES);

export type DatabaseTenantInvitation = {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedBy: string;
  status: TenantInvitationStatus;
  expiresAt: FiremixTimestamp;
  createdAt: FiremixTimestamp;
  updatedAt: FiremixTimestamp;
};

export type TenantInvitation = Replace<
  DatabaseTenantInvitation,
  FiremixTimestamp,
  string
>;

export const TenantInvitationZod = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    email: z.string().email(),
    role: TenantRoleZod,
    invitedBy: z.string(),
    status: TenantInvitationStatusZod,
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict() satisfies z.ZodType<TenantInvitation>;
