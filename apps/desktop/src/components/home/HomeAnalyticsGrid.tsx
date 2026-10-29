import { Box, Tooltip } from "@mui/material";
import { Flame } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";
import type {
  DailyActivityStatus,
  DailyWordActivity,
} from "../../types/home.types";
import type { DictationSpeed } from "../../utils/user.utils";
import { activityHeatmapGeometry } from "../../styles/activity-heatmap";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { HomeMetricCard } from "./HomeMetricCard";

type HomeAnalyticsGridProps = {
  streak: number;
  wordsThisMonth: number;
  wordsTotal: number;
  dictationSpeed: DictationSpeed | null;
  activity: DailyWordActivity[];
  activityStatus: DailyActivityStatus;
  today: Date;
};

export const HomeAnalyticsGrid = ({
  streak,
  wordsThisMonth,
  wordsTotal,
  dictationSpeed,
  activity,
  activityStatus,
  today,
}: HomeAnalyticsGridProps) => {
  const intl = useIntl();

  return (
    <Box
      data-testid="home-analytics-grid"
      sx={{
        display: "grid",
        minWidth: 0,
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gridTemplateAreas: dictationSpeed
          ? '"streak month" "total speed" "activity activity"'
          : '"streak month" "total ." "activity activity"',
        gap: 1.5,
        alignItems: "stretch",
        "@container home-page (min-width: 560px)": {
          width: "calc(100% - 4px)",
          gridTemplateColumns:
            "minmax(140px, 0.97fr) minmax(0, 1.82fr) minmax(140px, 0.99fr)",
          gridTemplateRows: "repeat(2, minmax(76px, auto))",
          rowGap: 1.375,
          gridTemplateAreas: dictationSpeed
            ? '"streak activity total" "month activity speed"'
            : '"streak activity total" "month activity total"',
        },
      }}
    >
      <Box
        data-home-grid-area="streak"
        sx={{ gridArea: "streak", minWidth: 0 }}
      >
        <HomeMetricCard
          value={intl.formatNumber(streak)}
          label={<FormattedMessage defaultMessage="Day streak" />}
          icon={<Flame size={22} strokeWidth={2} color="#FF6B35" />}
        />
      </Box>
      <Box data-home-grid-area="month" sx={{ gridArea: "month", minWidth: 0 }}>
        <HomeMetricCard
          value={intl.formatNumber(wordsThisMonth)}
          label={<FormattedMessage defaultMessage="Words this month" />}
        />
      </Box>
      <Box
        data-home-grid-area="total"
        sx={{
          gridArea: "total",
          minWidth: 0,
          alignSelf: dictationSpeed ? "stretch" : "center",
        }}
      >
        <HomeMetricCard
          value={intl.formatNumber(wordsTotal)}
          label={<FormattedMessage defaultMessage="Words total" />}
          align="right"
        />
      </Box>
      {dictationSpeed ? (
        <Box
          data-home-grid-area="speed"
          sx={{ gridArea: "speed", minWidth: 0 }}
        >
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
                  { defaultMessage: "{wpm} WPM" },
                  { wpm: dictationSpeed.wpm },
                )}
                detail={
                  <FormattedMessage
                    defaultMessage="{multiplier}x faster than typing"
                    values={{
                      multiplier: (dictationSpeed.wpm / 40).toFixed(1),
                    }}
                  />
                }
                align="right"
              />
            </Box>
          </Tooltip>
        </Box>
      ) : null}
      <Box
        data-home-grid-area="activity"
        sx={{
          gridArea: "activity",
          minWidth: 0,
          alignSelf: "center",
          justifySelf: "center",
          maxWidth: activityHeatmapGeometry.viewportWidth,
          width: "100%",
          "@container home-page (min-width: 560px)": {
            // The heatmap owns its rail and plot gutters; keep its hitbox in this track.
            justifySelf: "start",
          },
        }}
      >
        <ActivityHeatmap
          activity={activity}
          status={activityStatus}
          today={today}
        />
      </Box>
    </Box>
  );
};
