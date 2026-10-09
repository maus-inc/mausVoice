import {
  Box,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type {
  DailyActivityStatus,
  DailyWordActivity,
} from "../../types/home.types";
import { dateFromLocalDateKey } from "../../utils/date.utils";
import { buildActivityGrid } from "../../utils/activity-grid.utils";
import { activityHeatmap } from "../../styles/palette";

const CELL_SIZE = 11;
const CELL_GAP = 3;

export type ActivityHeatmapProps = {
  activity: DailyWordActivity[];
  status: DailyActivityStatus;
  today?: Date;
};

export const ActivityHeatmap = ({
  activity,
  status,
  today,
}: ActivityHeatmapProps) => {
  const intl = useIntl();
  const theme = useTheme();
  const grid = useMemo(
    () => buildActivityGrid(activity, today),
    [activity, today],
  );
  const colors =
    theme.palette.mode === "dark"
      ? activityHeatmap.dark
      : activityHeatmap.light;
  const visibleCells = grid.weeks.flat().filter((cell) => !cell.isFuture);
  const activeDays = visibleCells.filter((cell) => cell.wordCount > 0).length;
  const totalWords = visibleCells.reduce(
    (total, cell) => total + cell.wordCount,
    0,
  );
  const activeDaysLabel = intl.formatMessage(
    {
      defaultMessage:
        "{count, plural, one {# active day} other {# active days}}",
    },
    { count: activeDays },
  );
  const accessibleSummary = intl.formatMessage(
    {
      defaultMessage:
        "Daily word activity: {activeDays, plural, one {# active day} other {# active days}} and {totalWords, number} words in the past year.",
    },
    { activeDays, totalWords },
  );
  const describeCell = (localDate: string, wordCount: number) =>
    intl.formatMessage(
      {
        defaultMessage:
          "{date, date, medium}: {wordCount, plural, one {# word} other {# words}}",
      },
      { date: dateFromLocalDateKey(localDate), wordCount },
    );

  const weekdayLabels = [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const sample = new Date(2024, 0, 7 + day, 12);
    return intl.formatDate(sample, { weekday: "short" });
  });

  return (
    <Box
      component="section"
      aria-labelledby="home-activity-heading"
      data-testid="home-activity-heatmap"
      sx={{ minWidth: 0 }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "baseline",
          justifyContent: "space-between",
          mb: 1.5,
        }}
      >
        <Box>
          <Typography
            id="home-activity-heading"
            variant="h6"
            sx={{ fontWeight: 600 }}
          >
            <FormattedMessage defaultMessage="Daily activity" />
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            <FormattedMessage defaultMessage="Words dictated over the past year" />
          </Typography>
        </Box>
        {status === "success" ? (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", whiteSpace: "nowrap" }}
          >
            {activeDaysLabel}
          </Typography>
        ) : null}
      </Stack>

      {status === "loading" || status === "idle" ? (
        <LinearProgress
          aria-label={intl.formatMessage({
            defaultMessage: "Loading daily activity",
          })}
        />
      ) : status === "error" ? (
        <Typography
          role="status"
          variant="body2"
          sx={{ color: "text.secondary", py: 2 }}
        >
          <FormattedMessage defaultMessage="Daily activity could not be loaded." />
        </Typography>
      ) : (
        <Box sx={{ overflowX: "auto", pb: 0.5 }}>
          <Box sx={{ minWidth: 760, width: "max-content" }}>
            <Box
              aria-hidden="true"
              sx={{
                display: "grid",
                gridTemplateColumns: `24px repeat(${grid.weeks.length}, ${CELL_SIZE}px)`,
                columnGap: `${CELL_GAP}px`,
                mb: 0.5,
                alignItems: "end",
              }}
            >
              <Box />
              {grid.weeks.map((week, index) => {
                const weekDate = dateFromLocalDateKey(week[0].localDate);
                const monthStart = week.find(
                  (cell) =>
                    dateFromLocalDateKey(cell.localDate).getDate() === 1,
                );
                const labelDate = monthStart
                  ? dateFromLocalDateKey(monthStart.localDate)
                  : weekDate;
                const startsNewMonth = index === 0 || monthStart !== undefined;
                return (
                  <Typography
                    key={week[0].localDate}
                    variant="caption"
                    sx={{
                      gridColumn: index + 2,
                      gridRow: 1,
                      color: "text.secondary",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                      visibility: startsNewMonth ? "visible" : "hidden",
                    }}
                  >
                    {startsNewMonth
                      ? intl.formatDate(labelDate, { month: "short" })
                      : ""}
                  </Typography>
                );
              })}
            </Box>

            <Box
              role="img"
              aria-label={accessibleSummary}
              sx={{
                display: "grid",
                gridTemplateColumns: `24px repeat(${grid.weeks.length}, ${CELL_SIZE}px)`,
                gridTemplateRows: `repeat(7, ${CELL_SIZE}px)`,
                columnGap: `${CELL_GAP}px`,
                rowGap: `${CELL_GAP}px`,
                alignItems: "center",
              }}
            >
              {weekdayLabels.map((label, dayIndex) => (
                <Typography
                  key={`weekday-${dayIndex}`}
                  aria-hidden="true"
                  variant="caption"
                  sx={{
                    gridColumn: 1,
                    gridRow: dayIndex + 1,
                    color: "text.secondary",
                    fontSize: 9,
                    lineHeight: `${CELL_SIZE}px`,
                    textAlign: "right",
                    pr: 0.5,
                    visibility: dayIndex % 2 === 0 ? "visible" : "hidden",
                  }}
                >
                  {label}
                </Typography>
              ))}
              {grid.weeks.flatMap((week, weekIndex) =>
                week.map((cell, dayIndex) => {
                  const description = describeCell(
                    cell.localDate,
                    cell.wordCount,
                  );
                  return (
                    <Tooltip
                      key={cell.localDate}
                      title={cell.isFuture ? "" : description}
                      arrow
                      placement="top"
                      disableHoverListener={cell.isFuture}
                    >
                      <Box
                        aria-hidden="true"
                        data-date={cell.localDate}
                        data-word-count={cell.wordCount}
                        data-intensity={cell.intensity}
                        data-testid="activity-day"
                        sx={{
                          gridColumn: weekIndex + 2,
                          gridRow: dayIndex + 1,
                          width: CELL_SIZE,
                          height: CELL_SIZE,
                          borderRadius: 0.15,
                          bgcolor: cell.isFuture
                            ? "transparent"
                            : colors[cell.intensity],
                          outline: cell.isToday
                            ? `1px solid ${theme.palette.text.secondary}`
                            : "none",
                          outlineOffset: 1,
                          pointerEvents: cell.isFuture ? "none" : "auto",
                        }}
                      />
                    </Tooltip>
                  );
                }),
              )}
            </Box>
          </Box>
        </Box>
      )}

      {status === "success" ? (
        <Box
          component="ol"
          aria-label={intl.formatMessage({
            defaultMessage: "Daily word counts",
          })}
          sx={{
            position: "absolute",
            width: "1px",
            height: "1px",
            p: 0,
            m: "-1px",
            overflow: "hidden",
            clip: "rect(0, 0, 0, 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {visibleCells.map((cell) => (
            <li key={`accessible-${cell.localDate}`}>
              {describeCell(cell.localDate, cell.wordCount)}
            </li>
          ))}
        </Box>
      ) : null}

      {status === "success" && activeDays === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          <FormattedMessage defaultMessage="Your dictation activity will appear here." />
        </Typography>
      ) : null}

      <Stack
        role="group"
        direction="row"
        spacing={0.75}
        sx={{ justifyContent: "flex-end", alignItems: "center", mt: 1 }}
        aria-label={intl.formatMessage({
          defaultMessage: "Activity level legend",
        })}
      >
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="Less" />
        </Typography>
        {colors.map((color, index) => (
          <Box
            key={`legend-${index}`}
            aria-hidden="true"
            sx={{
              width: CELL_SIZE,
              height: CELL_SIZE,
              borderRadius: 0.15,
              bgcolor: color,
            }}
          />
        ))}
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="More" />
        </Typography>
      </Stack>
    </Box>
  );
};
