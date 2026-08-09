import { FiremixTimestamp } from "@firemix/core";
import z from "zod";
import { Nullable, Replace } from "./common.types";

export const TENANT_ROLES = ["owner", "admin", "member"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
export const TenantRoleZod = z.enum(TENANT_ROLES);

export type DatabaseTenant = {
  id: string;
  createdAt: FiremixTimestamp;
  updatedAt: FiremixTimestamp;
  name: string;
  createdBy: string;
  /** Total seats purchased for this tenant. Source of truth: Stripe webhook. */
  seatCount: number;
  /** Stripe customer ID — set the first time the tenant opens checkout. */
  stripeCustomerId?: Nullable<string>;
  /** Most recent active subscription ID, set by the webhook. */
  stripeSubscriptionId?: Nullable<string>;
};

export type Tenant = Replace<DatabaseTenant, FiremixTimestamp, string>;

export const TenantZod = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    createdBy: z.string(),
    seatCount: z.number().int().nonnegative(),
    stripeCustomerId: z.string().nullable().optional(),
    stripeSubscriptionId: z.string().nullable().optional(),
  })
  .strict() satisfies z.ZodType<Tenant>;
