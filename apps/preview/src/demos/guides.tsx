/**
 * Home analytics for the preview app. The guides capture this grid from the
 * running desktop app, so this demo exists to inspect the same component in
 * both themes without a build.
 */
import { Box } from "@mui/material";
import type { DailyWordActivity } from "@maus-inc/desktop-native-apis";
import { HomeAnalyticsGrid } from "@desktop/components/home/HomeAnalyticsGrid";
import { toLocalDateKey } from "@desktop/utils/date.utils";
import { DemoSection } from "../components/demo-ui";

const TODAY = new Date(2026, 10, 20, 12);

/** Deterministic 53 week history ending today, with a 12 day streak and gaps. */
const wordCountFor = (date: Date, offset: number): number => {
  const base = (offset * 37) % 11;
  if (offset <= 11) return 420 + base * 31;
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (weekend && offset % 3 === 0) return 0;
  if (base === 0) return 0;
  return 120 + base * 68;
};

const buildActivity = (): DailyWordActivity[] => {
  const days: DailyWordActivity[] = [];
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = new Date(TODAY);
    date.setDate(date.getDate() - offset);
    days.push({
      localDate: toLocalDateKey(date),
      wordCount: wordCountFor(date, offset),
    });
  }
  return days;
};

const ACTIVITY = buildActivity();

export const HomeHeatmapDemo = () => (
  <DemoSection
    title="Home analytics (real component)"
    hint="HomeAnalyticsGrid from apps/desktop/src/components/home, rendered with a 53 week fixture. The home guides capture the same component from the running app."
  >
    <Box
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
