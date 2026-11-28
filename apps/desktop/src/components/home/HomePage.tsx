import { Box, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useAppStore } from "../../store";
import { useLocalToday } from "../../hooks/use-local-today";
import {
  getDictationSpeed,
  getEffectiveStreak,
  getMyUser,
  getMyUserFirstName,
} from "../../utils/user.utils";
import { toLocalMonthKey } from "../../utils/date.utils";
import { DictationInstruction } from "../common/DictationInstruction";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";
import { VoquillMigrationBanner } from "../migration/VoquillMigrationBanner";
import { GettingStartedList } from "./GettingStartedList";
import { HomeAnalyticsGrid } from "./HomeAnalyticsGrid";
import { HomeRecentTranscriptions } from "./HomeRecentTranscriptions";
import { HomeSideEffects } from "./HomeSideEffects";

export default function HomePage() {
  const user = useAppStore(getMyUser);
  const userFirstName = useAppStore(getMyUserFirstName);
  const streak = useAppStore(getEffectiveStreak);
  const dictationSpeed = useAppStore(getDictationSpeed);
  const activity = useAppStore((state) => state.home.dailyActivity);
  const activityStatus = useAppStore((state) => state.home.dailyActivityStatus);
  const today = useLocalToday();

  const month = toLocalMonthKey(today);
  const wordsThisMonth =
    user?.wordsThisMonthMonth === month ? (user.wordsThisMonth ?? 0) : 0;
  const wordsTotal = user?.wordsTotal ?? 0;

  return (
    <DashboardEntryLayout maxWidth="xl">
      <HomeSideEffects today={today} />
      <Box
        data-testid="home-page-frame"
        sx={{
          width: "100%",
          maxWidth: 676,
          minWidth: 0,
          mx: "auto",
          px: 3.5,
          containerName: "home-page",
          containerType: "inline-size",
        }}
      >
        <Stack sx={{ minWidth: 0 }}>
          <Box sx={{ mb: 4.5 }}>
            <Typography variant="h4" sx={{ fontWeight: 500, mb: 0.5 }}>
              <FormattedMessage
                defaultMessage="Welcome back, {name}"
                values={{
                  name: (
                    <span
                      key="user-name"
                      style={{
                        fontFamily: "var(--font-display)",
                        fontSize: "0.92em",
                      }}
                    >
                      {userFirstName}
                    </span>
                  ),
                }}
              />
            </Typography>
            <DictationInstruction use3dKeycaps />
          </Box>

          <Box sx={{ mb: 3, "&:empty": { display: "none" } }}>
            <VoquillMigrationBanner />
          </Box>

          <HomeAnalyticsGrid
            streak={streak}
            wordsThisMonth={wordsThisMonth}
            wordsTotal={wordsTotal}
            dictationSpeed={dictationSpeed}
            activity={activity}
            activityStatus={activityStatus}
            today={today}
          />

          <Box
            sx={{
              mt: 4,
              pt: 3.5,
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            <Box sx={{ "&:empty": { display: "none" }, mb: 3 }}>
              <GettingStartedList />
            </Box>
            <HomeRecentTranscriptions />
          </Box>
        </Stack>
      </Box>
    </DashboardEntryLayout>
  );
}
