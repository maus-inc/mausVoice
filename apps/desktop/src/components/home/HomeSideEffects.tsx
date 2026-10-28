import { useCallback, useEffect, useRef } from "react";
import { refreshCurrentUser } from "../../actions/user.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { getDailyActivityRepo, getTranscriptionRepo } from "../../repos";
import { produceAppState } from "../../store";
import { getActivityDateRange } from "../../utils/activity-grid.utils";
import { getLogger } from "../../utils/log.utils";
import { subscribeToDailyActivityChanges } from "../../utils/daily-activity.events";
import { registerTranscriptions } from "../../utils/app.utils";

type HomeSideEffectsProps = {
  today: Date;
};

const useRefreshCurrentUser = () => {
  const pendingRef = useRef(false);

  return useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      await refreshCurrentUser();
    } finally {
      pendingRef.current = false;
    }
  }, []);
};

export const HomeSideEffects = ({ today }: HomeSideEffectsProps) => {
  const refresh = useRefreshCurrentUser();
  const activityRequestRef = useRef(0);

  const loadDailyActivity = useCallback(async () => {
    const requestId = ++activityRequestRef.current;
    const range = getActivityDateRange(today);
    produceAppState((draft) => {
      draft.home.dailyActivityStatus = "loading";
    });
    try {
      const activity = await getDailyActivityRepo().listDailyActivity(
        range.startDate,
        range.endDate,
      );
      if (activityRequestRef.current !== requestId) return;
      produceAppState((draft) => {
        draft.home.dailyActivity = activity;
        draft.home.dailyActivityStatus = "success";
      });
    } catch (error) {
      if (activityRequestRef.current !== requestId) return;
      getLogger().warning(`Failed to load daily activity: ${error}`);
      produceAppState((draft) => {
        draft.home.dailyActivityStatus = "error";
      });
    }
  }, [today]);

  useAsyncEffect(async () => {
    const transcriptionsPromise = getTranscriptionRepo()
      .listTranscriptions()
      .catch((error: unknown) => {
        getLogger().warning(`Failed to load recent transcriptions: ${error}`);
        return null;
      });
    const refreshPromise = refresh().catch((error: unknown) => {
      getLogger().warning(`Failed to refresh current user: ${error}`);
    });
    const [, transcriptions] = await Promise.all([
      refreshPromise,
      transcriptionsPromise,
    ]);
    if (!transcriptions) return;
    produceAppState((draft) => {
      registerTranscriptions(draft, transcriptions);
      draft.transcriptions.transcriptionIds = transcriptions.map((t) => t.id);
    });
  }, [refresh]);

  useEffect(() => {
    loadDailyActivity();
    return () => {
      activityRequestRef.current += 1;
    };
  }, [loadDailyActivity]);

  useEffect(() => {
    const handleRefresh = () => {
      refresh().catch((error: unknown) => {
        getLogger().warning(`Failed to refresh current user: ${error}`);
      });
      loadDailyActivity();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") handleRefresh();
    };
    const unsubscribeActivity = subscribeToDailyActivityChanges(() => {
      loadDailyActivity();
    });

    window.addEventListener("focus", handleRefresh);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      activityRequestRef.current += 1;
      unsubscribeActivity();
      window.removeEventListener("focus", handleRefresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, loadDailyActivity]);

  return null;
};
