import { Flame } from "lucide-react";
import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store";
import {
  getDictationSpeed,
  getEffectiveStreak,
  getMyUser,
  getMyUserFirstName,
} from "../../utils/user.utils";
import { toLocalMonthKey } from "../../utils/date.utils";
import { DictationInstruction } from "../common/DictationInstruction";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";
import { TranscriptionRow } from "../transcriptions/TranscriptRow";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { GettingStartedList } from "./GettingStartedList";
import { HomeMetricCard } from "./HomeMetricCard";
import { HomeSideEffects } from "./HomeSideEffects";

/**
 * Home dashboard: recent usage, daily activity, getting-started guidance, and
 * recent transcriptions, with the side effects that keep them fresh.
 *
 * The header left slot intentionally stays empty here — publishing a "Home"
 * label into the title bar was a regression, not a design requirement.
 */
export default function HomePage() {
  const user = useAppStore(getMyUser);
  const userFirstName = useAppStore(getMyUserFirstName);
  const streak = useAppStore(getEffectiveStreak);
  const dictationSpeed = useAppStore(getDictationSpeed);
  const activity = useAppStore((state) => state.home.dailyActivity);
  const activityStatus = useAppStore((state) => state.home.dailyActivityStatus);
  const intl = useIntl();
  const navigate = useNavigate();

  const month = toLocalMonthKey(new Date());
  const wordsThisMonth =
    user?.wordsThisMonthMonth === month ? (user.wordsThisMonth ?? 0) : 0;
  const wordsTotal = user?.wordsTotal ?? 0;
  const recentIds = useAppStore(
    (state) => state.transcriptions.transcriptionIds,
  );
  const topIds = useMemo(() => recentIds.slice(0, 2), [recentIds]);

  return (
    <DashboardEntryLayout maxWidth="xl">
      <HomeSideEffects />
      <Stack spacing={3} sx={{ minWidth: 0 }}>
        <Box>
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
          <DictationInstruction />
        </Box>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "repeat(2, minmax(0, 1fr))",
              lg: dictationSpeed
                ? "repeat(4, minmax(0, 1fr))"
                : "repeat(3, minmax(0, 1fr))",
            },
            gap: 1.5,
          }}
        >
          <HomeMetricCard
            value={intl.formatNumber(streak)}
            label={<FormattedMessage defaultMessage="Day streak" />}
            icon={<Flame size={22} strokeWidth={2} color="#FF6B35" />}
          />
          <HomeMetricCard
            value={intl.formatNumber(wordsThisMonth)}
            label={<FormattedMessage defaultMessage="Words this month" />}
          />
          <HomeMetricCard
            value={intl.formatNumber(wordsTotal)}
            label={<FormattedMessage defaultMessage="Words total" />}
          />
          {dictationSpeed ? (
            <Tooltip
              title={intl.formatMessage(
                {
                  defaultMessage:
                    "Average words per minute across your last {count, plural, one {# dictation} other {# dictations}}. Compared against a median typing speed of 40 WPM.",
                },
                { count: dictationSpeed.sampleCount },
              )}
              arrow
              placement="bottom"
            >
              <Box>
                <HomeMetricCard
                  value={intl.formatMessage(
                    {
                      defaultMessage: "{wpm} WPM",
                    },
                    { wpm: dictationSpeed.wpm },
                  )}
                  label={<FormattedMessage defaultMessage="Dictation speed" />}
                  detail={
                    <FormattedMessage
                      defaultMessage="{multiplier}x faster than typing"
                      values={{
                        multiplier: (dictationSpeed.wpm / 40).toFixed(1),
                      }}
                    />
                  }
                />
              </Box>
            </Tooltip>
          ) : null}
        </Box>

        <ActivityHeatmap activity={activity} status={activityStatus} />

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              lg: "minmax(0, 1fr) minmax(0, 1fr)",
            },
            gap: 3,
            alignItems: "start",
          }}
        >
          <GettingStartedList />
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
              <FormattedMessage defaultMessage="Recent transcriptions" />
            </Typography>
            {topIds.length > 0 ? (
              <>
                {topIds.map((id) => (
                  <TranscriptionRow key={id} id={id} />
                ))}
                <Box
                  sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}
                >
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
                sx={{ color: "text.secondary", mt: 1 }}
              >
                <FormattedMessage defaultMessage="No transcriptions yet." />
              </Typography>
            )}
          </Box>
        </Box>
      </Stack>
    </DashboardEntryLayout>
  );
}
