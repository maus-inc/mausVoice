/**
 * Docs capture demos. These exist so `apps/docs/scripts/capture-preview.mjs`
 * can screenshot the REAL component the guides describe, rather than a
 * hand-built mock. Each capture root carries `data-capture="<figure id>"`.
 */
import { Box } from "@mui/material";
import type { DailyWordActivity } from "@maus-inc/desktop-native-apis";
import { HomeAnalyticsGrid } from "@desktop/components/home/HomeAnalyticsGrid";
import { toLocalDateKey } from "@desktop/utils/date.utils";
import { DemoSection } from "../components/demo-ui";

const TODAY = new Date(2026, 10, 20, 12);

/** Deterministic 53 week history ending today, with a 12 day streak and gaps. */
const buildActivity = (): DailyWordActivity[] => {
  const days: DailyWordActivity[] = [];
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = new Date(TODAY);
    date.setDate(date.getDate() - offset);
    const inStreak = offset <= 11;
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const base = (offset * 37) % 11;
    const wordCount = inStreak
      ? 420 + base * 31
      : weekend && offset % 3 === 0
        ? 0
        : base === 0
          ? 0
          : 120 + base * 68;
    days.push({ localDate: toLocalDateKey(date), wordCount });
  }
  return days;
};

const ACTIVITY = buildActivity();

export const HomeHeatmapDemo = () => (
  <DemoSection
    title="Home analytics (real component)"
    hint="HomeAnalyticsGrid from apps/desktop/src/components/home, rendered with a 53 week fixture. This is the surface the home guides capture."
  >
    <Box
      data-capture="home-heatmap"
      sx={{
        width: 720,
        p: 3,
        bgcolor: "background.paper",
        borderRadius: "12px",
        border: "1px solid",
        borderColor: "divider",
        containerType: "inline-size",
        containerName: "home-page",
      }}
    >
      <HomeAnalyticsGrid
        streak={12}
        wordsThisMonth={8400}
        wordsTotal={124300}
        dictationSpeed={{ wpm: 148, sampleCount: 26 }}
        activity={ACTIVITY}
        activityStatus="success"
        today={TODAY}
      />
    </Box>
  </DemoSection>
);
