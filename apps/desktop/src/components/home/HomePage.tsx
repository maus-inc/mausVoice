import { Box, Chip, Stack, Typography } from "@mui/material";
import { Flame } from "lucide-react";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store";
import { activityAtmosphere, activityStreakAccent } from "../../styles/palette";
import { getActivityDateRange } from "../../utils/activity-grid.utils";
import {
  getDictationSpeed,
  getEffectiveStreak,
  getMyUser,
  getMyUserFirstName,
} from "../../utils/user.utils";
import { DictationInstruction } from "../common/DictationInstruction";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";
import { TranscriptionRow } from "../transcriptions/TranscriptRow";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { GettingStartedList } from "./GettingStartedList";
import { HomeMetricCard } from "./HomeMetricCard";
import { HomeSideEffects } from "./HomeSideEffects";
import type { HomeActivityState } from "./home.types";

export default function HomePage() {
  const user = useAppStore(getMyUser);
  const userFirstName = useAppStore(getMyUserFirstName);
  const streak = useAppStore(getEffectiveStreak);
  const dictationSpeed = useAppStore(getDictationSpeed);
  const intl = useIntl();
  const navigate = useNavigate();
  const recentIds = useAppStore(
    (state) => state.transcriptions.transcriptionIds,
  );
  const topIds = useMemo(() => recentIds.slice(0, 2), [recentIds]);
  const [activity, setActivity] = useState<HomeActivityState>(() => ({
    status: "loading",
    records: [],
    ...getActivityDateRange(),
    hasLoaded: false,
  }));

  const multiplier = dictationSpeed
    ? intl.formatNumber(dictationSpeed.wpm / 40, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    : null;

  return (
    <DashboardEntryLayout maxWidth="xl">
      <HomeSideEffects onActivityChange={setActivity} />
      <Stack direction="column" spacing={3} sx={{ minWidth: 0 }}>
        <Box>
          <Typography
            variant="h4"
            sx={{
              fontWeight: 500,
              mb: 0.5,
              overflowWrap: "anywhere",
            }}
          >
            <FormattedMessage
              defaultMessage="Welcome back, {name}"
              values={{
                name: (
                  <span
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
          <DictationInstruction />
        </Box>

        <Box
          component="section"
          aria-label={intl.formatMessage({ defaultMessage: "Home analytics" })}
          sx={(theme) => ({
            minWidth: 0,
            mx: -1,
            p: 1,
            borderRadius: 2,
            backgroundImage: activityAtmosphere[theme.palette.mode],
          })}
        >
          <Box
            data-testid="home-analytics-grid"
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "repeat(2, minmax(0, 1fr))",
                md: "minmax(132px, 0.68fr) minmax(0, 2.6fr) minmax(132px, 0.68fr)",
              },
              gridTemplateAreas: {
                xs: '"streak month" "total speed" "activity activity"',
                md: '"streak activity total" "month activity speed"',
              },
              gap: { xs: 1, md: 1.5 },
              alignItems: "stretch",
              minWidth: 0,
            }}
          >
            <Box sx={{ gridArea: "streak", minWidth: 0 }}>
              <HomeMetricCard
                label={<FormattedMessage defaultMessage="Day streak" />}
                value={intl.formatNumber(streak)}
                icon={
                  <Box
                    sx={(theme) => ({
                      display: "flex",
                      color: activityStreakAccent[theme.palette.mode],
                    })}
                  >
                    <Flame size={21} strokeWidth={2} aria-hidden="true" />
                  </Box>
                }
              />
            </Box>

            <Box sx={{ gridArea: "month", minWidth: 0 }}>
              <HomeMetricCard
                label={<FormattedMessage defaultMessage="Words this month" />}
                value={intl.formatNumber(user?.wordsThisMonth ?? 0)}
              />
            </Box>

            <Box sx={{ gridArea: "total", minWidth: 0 }}>
              <HomeMetricCard
                label={<FormattedMessage defaultMessage="Lifetime words" />}
                value={intl.formatNumber(user?.wordsTotal ?? 0)}
              />
            </Box>

            <Box sx={{ gridArea: "speed", minWidth: 0 }}>
              <HomeMetricCard
                label={<FormattedMessage defaultMessage="Speaking speed" />}
                value={
                  dictationSpeed ? (
                    <FormattedMessage
                      defaultMessage="{wpm, number} WPM"
                      values={{ wpm: dictationSpeed.wpm }}
                    />
                  ) : (
                    "—"
                  )
                }
                detail={
                  dictationSpeed && multiplier ? (
                    <FormattedMessage
                      defaultMessage="Average across {count, plural, one {# recent dictation} other {# recent dictations}} · {multiplier}× the 40 WPM typing baseline"
                      values={{
                        count: dictationSpeed.sampleCount,
                        multiplier,
                      }}
                    />
                  ) : (
                    <FormattedMessage defaultMessage="No recent dictations have usable audio duration yet." />
                  )
                }
              />
            </Box>

            <Box sx={{ gridArea: "activity", minWidth: 0 }}>
              <ActivityHeatmap {...activity} />
            </Box>
          </Box>
        </Box>

        <GettingStartedList />

        <Box>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
              mb: 0.5,
            }}
          >
            <FormattedMessage defaultMessage="Recent transcriptions" />
          </Typography>
          {topIds.length > 0 ? (
            <>
              {topIds.map((id) => (
                <TranscriptionRow key={id} id={id} />
              ))}
              <Box sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}>
                <Chip
                  label={<FormattedMessage defaultMessage="View all" />}
                  variant="outlined"
                  clickable
                  onClick={() => navigate("/dashboard/transcriptions")}
                  sx={{ border: "none" }}
                />
              </Box>
            </>
          ) : (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mt: 1,
              }}
            >
              <FormattedMessage defaultMessage="No transcriptions yet." />
            </Typography>
          )}
        </Box>
      </Stack>
    </DashboardEntryLayout>
  );
}
