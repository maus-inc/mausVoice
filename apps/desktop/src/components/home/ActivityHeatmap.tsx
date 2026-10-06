import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { activityHeatmap } from "../../styles/palette";
import {
  ACTIVITY_DAYS_PER_WEEK,
  ACTIVITY_WEEKS,
  buildActivityGrid,
  getActivityDay,
  moveActivityFocus,
  type ActivityDay,
} from "../../utils/activity-grid.utils";
import { dateFromLocalKey } from "../../utils/date.utils";
import { requestDailyActivityRefresh } from "../../utils/daily-activity.events";
import type { HomeActivityState } from "./home.types";

const VISIBLE_WEEKDAY_LABELS = new Set([0, 2, 4, 5]);

const numberFormat = (intl: ReturnType<typeof useIntl>, value: number) =>
  intl.formatNumber(value);

const VisuallyHidden = ({ children }: { children: React.ReactNode }) => (
  <Box
    sx={{
      position: "absolute",
      width: 1,
      height: 1,
      padding: 0,
      margin: -1,
      overflow: "hidden",
      clip: "rect(0, 0, 0, 0)",
      whiteSpace: "nowrap",
      border: 0,
    }}
  >
    {children}
  </Box>
);

type ActivityHeatmapProps = HomeActivityState;

export const ActivityHeatmap = ({
  status,
  records,
  endDate,
  hasLoaded,
}: ActivityHeatmapProps) => {
  const intl = useIntl();
  const gridId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const [activeDateKey, setActiveDateKey] = useState(endDate);
  const [hoveredDateKey, setHoveredDateKey] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const grid = useMemo(
    () => buildActivityGrid(records, dateFromLocalKey(endDate)),
    [endDate, records],
  );
  const visibleDays = useMemo(
    () => grid.weeks.flat().filter((day) => !day.isFuture),
    [grid.weeks],
  );
  const fallbackDay = visibleDays.at(-1);
  const activeDay =
    visibleDays.find((day) => day.dateKey === activeDateKey) ?? fallbackDay;
  const hoveredDay = hoveredDateKey
    ? visibleDays.find((day) => day.dateKey === hoveredDateKey)
    : undefined;
  const detailDay = hoveredDay ?? activeDay;
  const activityColors = activityHeatmap;
  const activeCellId = activeDay
    ? `${gridId}-day-${activeDay.dateKey}`
    : undefined;
  const hasActivity = records.some((record) => record.wordCount > 0);
  const weekdayDates = grid.weeks[0] ?? [];

  useEffect(() => {
    setActiveDateKey(endDate);
    setHoveredDateKey(null);
  }, [endDate]);

  const getCellLabel = (day: ActivityDay): string =>
    intl.formatMessage(
      {
        defaultMessage: "Saved words for {date}: {wordCount, number}",
      },
      {
        date: intl.formatDate(day.date, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
        wordCount: day.wordCount,
      },
    );

  const activateDay = (day: ActivityDay) => {
    setActiveDateKey(day.dateKey);
    setHoveredDateKey(null);
    gridRef.current?.focus({ preventScroll: true });
  };

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!activeDay) return;
    const current = {
      weekIndex: activeDay.weekIndex,
      weekdayIndex: activeDay.weekdayIndex,
    };
    let next: { weekIndex: number; weekdayIndex: number } | undefined;

    switch (event.key) {
      case "ArrowLeft":
        next = moveActivityFocus(grid.weeks, current, { week: -1, weekday: 0 });
        break;
      case "ArrowRight":
        next = moveActivityFocus(grid.weeks, current, { week: 1, weekday: 0 });
        break;
      case "ArrowUp":
        next = moveActivityFocus(grid.weeks, current, { week: 0, weekday: -1 });
        break;
      case "ArrowDown":
        next = moveActivityFocus(grid.weeks, current, { week: 0, weekday: 1 });
        break;
      case "Home":
        next = moveActivityFocus(grid.weeks, current, {
          week: -current.weekIndex,
          weekday: 0,
        });
        break;
      case "End": {
        let weekIndex = ACTIVITY_WEEKS - 1;
        while (
          weekIndex > 0 &&
          getActivityDay(grid.weeks, weekIndex, current.weekdayIndex)?.isFuture
        ) {
          weekIndex -= 1;
        }
        next = { weekIndex, weekdayIndex: current.weekdayIndex };
        break;
      }
      default:
        return;
    }

    event.preventDefault();
    const nextDay = getActivityDay(
      grid.weeks,
      next.weekIndex,
      next.weekdayIndex,
    );
    if (nextDay && !nextDay.isFuture) {
      setActiveDateKey(nextDay.dateKey);
      setHoveredDateKey(null);
    }
  };

  const retryButton = (
    <Button
      size="small"
      variant="outlined"
      onClick={requestDailyActivityRefresh}
      disabled={status === "loading"}
      sx={{ minWidth: 64, minHeight: 32 }}
    >
      <FormattedMessage defaultMessage="Retry" />
    </Button>
  );

  return (
    <Card
      component="section"
      aria-labelledby={`${gridId}-title`}
      aria-busy={status === "loading"}
      sx={{ height: "100%", minWidth: 0 }}
    >
      <CardContent
        sx={{
          p: { xs: 1.75, md: 2.25 },
          "&:last-child": { pb: { xs: 1.75, md: 2.25 } },
          minWidth: 0,
        }}
      >
        <Stack spacing={1.25}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={0.5}
            sx={{
              justifyContent: "space-between",
              alignItems: { sm: "baseline" },
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography
                id={`${gridId}-title`}
                variant="h6"
                sx={{ fontWeight: 650, lineHeight: 1.2 }}
              >
                <FormattedMessage defaultMessage="Daily saved words" />
              </Typography>
              <Typography variant="caption" color="text.secondary">
                <FormattedMessage defaultMessage="Last 26 weeks · local dates" />
              </Typography>
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexShrink: 0 }}
            >
              <FormattedMessage defaultMessage="Today is partial" />
            </Typography>
          </Stack>

          {status === "loading" && !hasLoaded ? (
            <Stack
              role="status"
              aria-live="polite"
              spacing={0.75}
              sx={{ minHeight: 178, justifyContent: "center" }}
            >
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Loading activity history…" />
              </Typography>
              <Skeleton
                aria-hidden="true"
                variant="rounded"
                animation={false}
                height={104}
                sx={{ opacity: 0.35 }}
              />
            </Stack>
          ) : status === "error" && !hasLoaded ? (
            <Alert
              severity="error"
              role="alert"
              action={retryButton}
              sx={{ minHeight: 178, alignItems: "center" }}
            >
              <FormattedMessage defaultMessage="We couldn't load saved-word activity. Your other Home data is still available." />
            </Alert>
          ) : (
            <>
              {status === "error" && hasLoaded && (
                <Alert severity="warning" action={retryButton}>
                  <FormattedMessage defaultMessage="Activity couldn't refresh. Showing the last successful result." />
                </Alert>
              )}

              <VisuallyHidden>
                <span id={`${gridId}-summary`}>
                  <FormattedMessage defaultMessage="A 26-week, Monday-first calendar. Each shade is relative to positive saved-word counts in this period. Use arrow keys to explore; future dates are omitted." />
                </span>
              </VisuallyHidden>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "20px minmax(0, 1fr)",
                  columnGap: 0.75,
                  alignItems: "stretch",
                  minWidth: 0,
                }}
              >
                <Box aria-hidden="true" />
                <Box
                  aria-hidden="true"
                  sx={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${ACTIVITY_WEEKS}, minmax(0, 1fr))`,
                    minWidth: 0,
                    minHeight: 18,
                  }}
                >
                  {grid.monthLabels.map(({ date, weekIndex, span }, index) => {
                    const includeYear =
                      date.getMonth() === 0 ||
                      (index === 0 &&
                        date.getFullYear() !== grid.today.getFullYear());
                    return (
                      <Typography
                        key={`${date.getFullYear()}-${date.getMonth()}`}
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        sx={{
                          gridColumn: `${weekIndex + 1} / span ${span}`,
                          alignSelf: "center",
                          fontSize: "0.68rem",
                        }}
                      >
                        {intl.formatDate(date, {
                          month: "short",
                          ...(includeYear ? { year: "2-digit" } : {}),
                        })}
                      </Typography>
                    );
                  })}
                </Box>

                <Box
                  ref={gridRef}
                  role="grid"
                  aria-label={intl.formatMessage({
                    defaultMessage:
                      "Daily saved-word activity for the last 26 weeks",
                  })}
                  aria-describedby={`${gridId}-summary ${gridId}-caveat`}
                  aria-activedescendant={activeCellId}
                  tabIndex={0}
                  onKeyDown={handleGridKeyDown}
                  sx={{
                    gridColumn: "1 / -1",
                    display: "grid",
                    rowGap: 0.35,
                    minWidth: 0,
                    borderRadius: 1,
                    outline: "none",
                    "&:focus-visible": {
                      outline: (theme) =>
                        `2px solid ${theme.vars.palette.chrome}`,
                      outlineOffset: 3,
                    },
                  }}
                >
                  {Array.from(
                    { length: ACTIVITY_DAYS_PER_WEEK },
                    (_, weekdayIndex) => {
                      const weekdayDay = weekdayDates[weekdayIndex];
                      const weekdayLong = weekdayDay
                        ? intl.formatDate(weekdayDay.date, { weekday: "long" })
                        : "";
                      const showLabel =
                        VISIBLE_WEEKDAY_LABELS.has(weekdayIndex);
                      return (
                        <Box
                          key={weekdayIndex}
                          role="row"
                          aria-label={weekdayLong}
                          sx={{
                            display: "grid",
                            gridTemplateColumns: `20px repeat(${ACTIVITY_WEEKS}, minmax(0, 1fr))`,
                            columnGap: 0.75,
                            minWidth: 0,
                            alignItems: "center",
                          }}
                        >
                          <Box
                            role="rowheader"
                            aria-label={weekdayLong}
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "flex-start",
                              minWidth: 0,
                            }}
                          >
                            {showLabel && (
                              <Typography
                                aria-hidden="true"
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontSize: "0.68rem", lineHeight: 1 }}
                              >
                                {weekdayDay
                                  ? intl.formatDate(weekdayDay.date, {
                                      weekday: "narrow",
                                    })
                                  : ""}
                              </Typography>
                            )}
                          </Box>

                          {grid.weeks.map((week) => {
                            const day = week[weekdayIndex]!;
                            if (day.isFuture) {
                              return (
                                <Box
                                  key={day.dateKey}
                                  aria-hidden="true"
                                  sx={{
                                    aspectRatio: "1",
                                    maxWidth: 15,
                                    width: "100%",
                                    justifySelf: "center",
                                  }}
                                />
                              );
                            }

                            const isActive = day.dateKey === activeDay?.dateKey;
                            return (
                              <Box
                                key={day.dateKey}
                                id={`${gridId}-day-${day.dateKey}`}
                                role="gridcell"
                                aria-label={getCellLabel(day)}
                                aria-selected={isActive}
                                onMouseEnter={() =>
                                  setHoveredDateKey(day.dateKey)
                                }
                                onMouseLeave={() => setHoveredDateKey(null)}
                                onClick={() => activateDay(day)}
                                sx={(theme) => {
                                  const colors =
                                    theme.palette.mode === "dark"
                                      ? activityColors.dark
                                      : activityColors.light;
                                  const color = colors[day.level] ?? colors[0];
                                  return {
                                    width: "100%",
                                    maxWidth: 15,
                                    aspectRatio: "1",
                                    justifySelf: "center",
                                    borderRadius: 0.25,
                                    backgroundColor: color,
                                    border: `1px solid ${theme.vars.palette.divider}`,
                                    boxSizing: "border-box",
                                    cursor: "default",
                                    boxShadow: isActive
                                      ? `0 0 0 2px ${theme.vars.palette.chrome}`
                                      : "none",
                                    "@media (forced-colors: active)": {
                                      borderColor: "CanvasText",
                                      forcedColorAdjust: "none",
                                    },
                                  };
                                }}
                              />
                            );
                          })}
                        </Box>
                      );
                    },
                  )}
                </Box>
              </Box>

              {detailDay && (
                <Typography
                  variant="body2"
                  sx={{
                    mt: 1,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    minHeight: 22,
                  }}
                >
                  {detailDay.dateKey === grid.endDate ? (
                    <FormattedMessage
                      defaultMessage="{date} · {wordCount, number} saved words so far today"
                      values={{
                        date: intl.formatDate(detailDay.date, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        }),
                        wordCount: detailDay.wordCount,
                      }}
                    />
                  ) : (
                    <FormattedMessage
                      defaultMessage="{date} · {wordCount, number} saved words"
                      values={{
                        date: intl.formatDate(detailDay.date, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                        }),
                        wordCount: detailDay.wordCount,
                      }}
                    />
                  )}
                </Typography>
              )}

              <Stack
                direction="row"
                spacing={0.75}
                sx={{
                  mt: 0.75,
                  flexWrap: "wrap",
                  rowGap: 0.5,
                  alignItems: "center",
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  <FormattedMessage defaultMessage="Less" />
                </Typography>
                <Stack direction="row" spacing={0.4} aria-hidden="true">
                  {Array.from({ length: 5 }, (_, level) => (
                    <Box
                      key={level}
                      sx={(theme) => ({
                        width: 11,
                        height: 11,
                        borderRadius: 0.25,
                        backgroundColor:
                          theme.palette.mode === "dark"
                            ? activityColors.dark[level]
                            : activityColors.light[level],
                        border: `1px solid ${theme.vars.palette.divider}`,
                      })}
                    />
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  <FormattedMessage defaultMessage="More" />
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: { xs: 0, sm: "auto !important" } }}
                >
                  <FormattedMessage defaultMessage="Relative to this 26-week period" />
                </Typography>
              </Stack>

              {!hasActivity && status === "ready" && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mt: 0.75 }}
                >
                  <FormattedMessage defaultMessage="No saved-word activity is represented for this period." />
                </Typography>
              )}

              <Typography
                id={`${gridId}-caveat`}
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.75, lineHeight: 1.45 }}
              >
                <FormattedMessage defaultMessage="This shows words from saved transcriptions and sessions that opted into stats. Transcripts deleted before this feature and earlier incognito day totals can't be recovered. A zero means no words are represented here—not proof that you didn't dictate." />
              </Typography>

              <Button
                variant="text"
                size="small"
                aria-expanded={showDetails}
                aria-controls={`${gridId}-details`}
                onClick={() => setShowDetails((visible) => !visible)}
                startIcon={
                  showDetails ? (
                    <ChevronUp size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )
                }
                sx={{
                  mt: 0.5,
                  minHeight: 32,
                  px: 0.5,
                  alignSelf: "flex-start",
                  textTransform: "none",
                }}
              >
                {showDetails ? (
                  <FormattedMessage defaultMessage="Hide activity details" />
                ) : (
                  <FormattedMessage defaultMessage="View activity details" />
                )}
              </Button>

              <TableContainer
                id={`${gridId}-details`}
                hidden={!showDetails}
                sx={{ maxHeight: 320, overflow: "auto", borderRadius: 1 }}
              >
                <Table
                  size="small"
                  aria-label={intl.formatMessage({
                    defaultMessage: "Daily saved-word details",
                  })}
                >
                  <caption
                    style={{
                      position: "absolute",
                      width: 1,
                      height: 1,
                      padding: 0,
                      margin: -1,
                      overflow: "hidden",
                      clip: "rect(0, 0, 0, 0)",
                      whiteSpace: "nowrap",
                      border: 0,
                    }}
                  >
                    {intl.formatMessage({
                      defaultMessage:
                        "Every visible local date and its represented saved-word count. Future dates are omitted.",
                    })}
                  </caption>
                  <TableHead>
                    <TableRow>
                      <TableCell scope="col">
                        <FormattedMessage defaultMessage="Date" />
                      </TableCell>
                      <TableCell scope="col" align="right">
                        <FormattedMessage defaultMessage="Saved words" />
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visibleDays.map((day) => (
                      <TableRow key={day.dateKey}>
                        <TableCell component="th" scope="row">
                          {intl.formatDate(day.date, {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </TableCell>
                        <TableCell align="right">
                          {numberFormat(intl, day.wordCount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
};
