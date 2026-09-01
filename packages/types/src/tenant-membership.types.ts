import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import { Replace } from "./common.types";
import { TenantRole, TenantRoleZod } from "./tenant.types";

export type DatabaseTenantMembership = {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  role: TenantRole;
  /** Whether this member currently occupies one of the tenant's purchased seats. */
  hasSeat: boolean;
  createdAt: FiremixTimestamp;
  updatedAt: FiremixTimestamp;
};

export type TenantMembership = Replace<
  DatabaseTenantMembership,
  FiremixTimestamp,
  string
>;

export const TenantMembershipZod = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    userId: z.string(),
    email: z.string().email(),
    role: TenantRoleZod,
    hasSeat: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict() satisfies z.ZodType<TenantMembership>;
