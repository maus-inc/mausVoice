import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { refreshCurrentUser } from "../../actions/user.actions";
import { getDailyActivityRepo, getTranscriptionRepo } from "../../repos";
import { produceAppState } from "../../store";
import { registerTranscriptions } from "../../utils/app.utils";
import { subscribeToDailyActivityRefresh } from "../../utils/daily-activity.events";
import { getActivityDateRange } from "../../utils/activity-grid.utils";
import { getLogger } from "../../utils/log.utils";
import type { HomeActivityState } from "./home.types";

type HomeSideEffectsProps = {
  onActivityChange: Dispatch<SetStateAction<HomeActivityState>>;
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

export const HomeSideEffects = ({ onActivityChange }: HomeSideEffectsProps) => {
  const refresh = useRefreshCurrentUser();
  const mountedRef = useRef(false);
  const activityRequestRef = useRef(0);
  const transcriptionRequestRef = useRef(0);

  const loadActivity = useCallback(async () => {
    const requestId = ++activityRequestRef.current;
    const range = getActivityDateRange();
    onActivityChange((previous) => ({
      ...previous,
      status: previous.hasLoaded ? "ready" : "loading",
      startDate: range.startDate,
      endDate: range.endDate,
    }));

    try {
      const records = await getDailyActivityRepo().listDailyWordActivity(
        range.startDate,
        range.endDate,
      );
      if (!mountedRef.current || requestId !== activityRequestRef.current) {
        return;
      }
      onActivityChange({
        status: "ready",
        records,
        startDate: range.startDate,
        endDate: range.endDate,
        hasLoaded: true,
      });
    } catch (error) {
      if (!mountedRef.current || requestId !== activityRequestRef.current) {
        return;
      }
      getLogger().warning(`Could not load Home activity: ${error}`);
      onActivityChange((previous) => ({
        ...previous,
        status: "error",
        startDate: range.startDate,
        endDate: range.endDate,
      }));
    }
  }, [onActivityChange]);

  const loadRecentTranscriptions = useCallback(async () => {
    const requestId = ++transcriptionRequestRef.current;
    try {
      const transcriptions = await getTranscriptionRepo().listTranscriptions();
      if (
        !mountedRef.current ||
        requestId !== transcriptionRequestRef.current
      ) {
        return;
      }
      produceAppState((draft) => {
        registerTranscriptions(draft, transcriptions);
        draft.transcriptions.transcriptionIds = transcriptions.map((t) => t.id);
      });
    } catch (error) {
      // Keep the rest of Home usable if the transcript feed alone is unavailable.
      getLogger().warning(`Could not load recent transcriptions: ${error}`);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activityRequestRef.current += 1;
      transcriptionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    void refresh();
    void loadRecentTranscriptions();
    void loadActivity();
  }, [loadActivity, loadRecentTranscriptions, refresh]);

  useEffect(
    () => subscribeToDailyActivityRefresh(() => void loadActivity()),
    [loadActivity],
  );

  useEffect(() => {
    const handleFocus = () => {
      void refresh();
      void loadActivity();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        void loadActivity();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loadActivity, refresh]);

  return null;
};
