import { invokeHandler } from "@maus-inc/functions";
import { Tenant, TenantRole } from "@maus-inc/types";
import { BaseRepo } from "./base.repo";

export type TenantWithRole = {
  tenant: Tenant;
  role: TenantRole;
  hasSeat: boolean;
};

export abstract class BaseTenantRepo extends BaseRepo {
  abstract listMine(): Promise<TenantWithRole[]>;
}

export class CloudTenantRepo extends BaseTenantRepo {
  async listMine(): Promise<TenantWithRole[]> {
    const { tenants } = await invokeHandler("tenant/listMine", {});
    return tenants;
  }
}
