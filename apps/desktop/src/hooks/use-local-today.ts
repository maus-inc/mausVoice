import { useEffect, useState } from "react";
import { toLocalDateKey } from "../utils/date.utils";

const atLocalNoon = (date: Date): Date => {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);
  return noon;
};

export const useLocalToday = (): Date => {
  const [today, setToday] = useState(() => atLocalNoon(new Date()));

  useEffect(() => {
    let timer: number | undefined;

    const refreshToday = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }

      const now = new Date();
      const todayAtNoon = atLocalNoon(now);
      setToday((current) =>
        toLocalDateKey(current) === toLocalDateKey(todayAtNoon)
          ? current
          : todayAtNoon,
      );

      const nextLocalMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
      timer = window.setTimeout(
        refreshToday,
        Math.max(1, nextLocalMidnight.getTime() - now.getTime() + 1),
      );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshToday();
      }
    };

    refreshToday();
    window.addEventListener("focus", refreshToday);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      window.removeEventListener("focus", refreshToday);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return today;
};
