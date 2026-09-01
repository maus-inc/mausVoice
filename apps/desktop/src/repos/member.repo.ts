import { Member, Nullable } from "@maus-inc/types";
import { BaseRepo } from "./base.repo";

export abstract class BaseMemberRepo extends BaseRepo {
  abstract tryInitialize(): Promise<void>;
  abstract getMyMember(): Promise<Nullable<Member>>;
}

export class LocalMemberRepo extends BaseMemberRepo {
  async tryInitialize(): Promise<void> {
    // noop
  }

  async getMyMember(): Promise<Nullable<Member>> {
    return null;
  }
}
