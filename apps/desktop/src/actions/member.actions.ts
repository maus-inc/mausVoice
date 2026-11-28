import { listify } from "@maus-inc/utilities";
import { getMemberRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { registerMembers } from "../utils/app.utils";

export async function refreshMember(
  lease?: LocalDataWriteLease,
): Promise<void> {
  const state = getAppState();
  const userId = state.auth?.uid;
  if (!userId) {
    return;
  }

  try {
    const member = await getMemberRepo().getMyMember();
    produceAppState((draft) => {
      registerMembers(draft, listify(member));
    }, lease);
  } catch {
    // No-op on failure
  }
}
