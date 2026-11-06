import type { Member, Nullable, User } from "@maus-inc/types";
import { listify } from "@maus-inc/utilities";
import type { Dispatch, SetStateAction } from "react";
import { combineLatest, from, of, type Observable } from "rxjs";
import { canRunPostElevationInit } from "../actions/elevation.actions";
import { getMemberRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { registerMembers, registerUsers } from "../utils/app.utils";
import { useStreamWithSideEffects } from "./stream.hooks";

type StreamRet = Nullable<[Nullable<Member>, Nullable<User>]>;

/** Load profile records for the current resolved auth session only. */
export function useAuthenticatedProfileStream({
  elevationReady,
  authReady,
  userId,
  authSessionNonce,
  setStreamReady,
}: {
  elevationReady: boolean;
  authReady: boolean;
  userId: string;
  authSessionNonce: number;
  setStreamReady: Dispatch<SetStateAction<boolean>>;
}) {
  useStreamWithSideEffects({
    builder: (): Observable<StreamRet> => {
      if (!canRunPostElevationInit(elevationReady, authReady)) {
        return of(null);
      }

      if (!userId) {
        return combineLatest([of(null), of(null)]);
      }

      return combineLatest([
        from(
          getMemberRepo()
            .getMyMember()
            .catch(() => null),
        ),
        from(
          getUserRepo()
            .getMyUser()
            .catch(() => null),
        ),
      ]);
    },
    onSuccess: (results) => {
      const state = getAppState();
      if (
        !canRunPostElevationInit(elevationReady, authReady) ||
        state.settings.elevationStartupPending ||
        state.authSessionNonce !== authSessionNonce
      ) {
        return;
      }
      setStreamReady(true);
      if (results === null) {
        return;
      }

      const [members, user] = results;
      produceAppState((draft) => {
        registerUsers(draft, listify(user));
        registerMembers(draft, listify(members));
      });
    },
    dependencies: [userId, authReady, elevationReady, authSessionNonce],
  });
}
