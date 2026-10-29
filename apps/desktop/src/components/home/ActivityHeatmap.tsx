import {
  Box,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useLayoutEffect, useMemo, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type {
  DailyActivityStatus,
  DailyWordActivity,
} from "../../types/home.types";
import { dateFromLocalDateKey, toLocalDateKey } from "../../utils/date.utils";
import {
  buildActivityGrid,
  type ActivityGrid,
  type ActivityGridCell,
} from "../../utils/activity-grid.utils";
import { activityHeatmap } from "../../styles/palette";
import { activityHeatmapGeometry } from "../../styles/activity-heatmap";
import { cssEase, duration, easeOutQuint } from "../../styles/motion";
import { useIsDarkMode } from "../../hooks/color-scheme.hooks";

type HeatmapColors = readonly string[];
type CellDescription = (localDate: string, wordCount: number) => string;
type WeekdayRow = {
  localDate: string;
  label: string;
  gridRow: number;
  visible: boolean;
};

export type ActivityHeatmapProps = {
  activity: DailyWordActivity[];
  status: DailyActivityStatus;
  today?: Date;
};

const makeWeekdayRows = (intl: ReturnType<typeof useIntl>): WeekdayRow[] =>
  Array.from({ length: 7 }, (_, day) => {
    const date = new Date(2024, 0, 8 + day, 12);
    return {
      localDate: toLocalDateKey(date),
      label: intl.formatDate(date, { weekday: "narrow" }),
      gridRow: day + 1,
      visible: day % 2 === 0,
    };
  });

const summarizeActivityGrid = (grid: ActivityGrid) => {
  const visibleCells = grid.weeks.flat().filter((cell) => !cell.isFuture);
  const activeDays = visibleCells.filter((cell) => cell.wordCount > 0).length;
  const totalWords = visibleCells.reduce(
    (total, cell) => total + cell.wordCount,
    0,
  );
  return { visibleCells, activeDays, totalWords };
};

const compactIntensity = (intensity: ActivityGridCell["intensity"]): number => {
  if (intensity === 0) return 0;
  if (intensity <= 2) return 1;
  return 2;
};

const ActivityHeatmapHeader = ({
  status,
  activeDaysLabel,
}: {
  status: DailyActivityStatus;
  activeDaysLabel: string;
}) => (
  <Box
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
    <Typography id="home-activity-heading">
      <FormattedMessage defaultMessage="Daily activity" />
    </Typography>
    <Typography>
      <FormattedMessage defaultMessage="Words dictated over the past year" />
    </Typography>
    {status === "success" ? <Typography>{activeDaysLabel}</Typography> : null}
  </Box>
);

const ActivityHeatmapGrid = ({
  grid,
  colors,
  accessibleSummary,
  weekdayRows,
  describeCell,
}: {
  grid: ActivityGrid;
  colors: HeatmapColors;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
}) => {
  const theme = useTheme();
  const viewportRef = useRef<HTMLDivElement>(null);
  const followsLatestWeek = useRef(true);

  // Keep recent weeks visible on load without pulling readers back after they
  // scroll into older history.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followsLatestWeek.current) return;
    viewport.scrollLeft = Math.max(
      0,
      viewport.scrollWidth - viewport.clientWidth,
    );
  }, [grid.endDate]);

  return (
    <Box
      ref={viewportRef}
      role="region"
      aria-labelledby="home-activity-heading"
      tabIndex={0}
      data-testid="activity-heatmap-viewport"
      onScroll={(event) => {
        const viewport = event.currentTarget;
        followsLatestWeek.current =
          viewport.scrollLeft + viewport.clientWidth >=
          viewport.scrollWidth - 1;
      }}
      sx={{ overflowX: "auto", pb: theme.spacing(0.5) }}
    >
      <Box
        sx={{
          minWidth: activityHeatmapGeometry.minWidth,
          width: "max-content",
          mx: "auto",
        }}
      >
        <Box
          role="img"
          aria-label={accessibleSummary}
          sx={{
            display: "grid",
            gridTemplateColumns: `${activityHeatmapGeometry.labelColumnWidth}px repeat(${grid.weeks.length}, ${activityHeatmapGeometry.cellSize}px)`,
            gridTemplateRows: `repeat(7, ${activityHeatmapGeometry.cellSize}px)`,
            columnGap: `${activityHeatmapGeometry.cellGap}px`,
            rowGap: `${activityHeatmapGeometry.cellGap}px`,
            alignItems: "center",
          }}
        >
          {weekdayRows.map(({ localDate, label, gridRow, visible }) => (
            <Typography
              key={localDate}
              aria-hidden="true"
              variant="caption"
              sx={{
                gridColumn: 1,
                gridRow,
                color: "text.secondary",
                fontFamily: "var(--font-data)",
                fontSize: 9,
                lineHeight: `${activityHeatmapGeometry.cellSize}px`,
                position: "sticky",
                left: 0,
                zIndex: 1,
                bgcolor: "background.default",
                textAlign: "right",
                pr: theme.spacing(0.5),
                visibility: visible ? "visible" : "hidden",
              }}
            >
              {label}
            </Typography>
          ))}
          {grid.weeks.flatMap((week, weekIndex) =>
            week.map((cell, dayIndex) => (
              <Tooltip
                key={cell.localDate}
                title={
                  cell.isFuture
                    ? ""
                    : describeCell(cell.localDate, cell.wordCount)
                }
                arrow
                placement="top"
                disableHoverListener={cell.isFuture}
                slotProps={{
                  tooltip: { sx: { fontFamily: "var(--font-data)" } },
                }}
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
                    width: activityHeatmapGeometry.cellSize,
                    height: activityHeatmapGeometry.cellSize,
                    borderRadius: 0.15,
                    bgcolor: cell.isFuture
                      ? "transparent"
                      : colors[compactIntensity(cell.intensity)],
                    outline: cell.isToday
                      ? `1px solid ${theme.palette.text.secondary}`
                      : "none",
                    outlineOffset: 1,
                    pointerEvents: cell.isFuture ? "none" : "auto",
                    transformOrigin: "center",
                    transition: `transform ${duration.fast}s ${cssEase(easeOutQuint)}`,
                    "@media (hover: hover) and (pointer: fine)": cell.isFuture
                      ? {}
                      : {
                          "&:hover": {
                            transform: "scale(1.35)",
                            outline: `1px solid ${theme.palette.text.primary}`,
                            zIndex: 1,
                          },
                        },
                    "@media (prefers-reduced-motion: reduce)": {
                      transition: "none",
                      "&:hover": { transform: "none" },
                    },
                  }}
                />
              </Tooltip>
            )),
          )}
        </Box>
      </Box>
    </Box>
  );
};

const ActivityHeatmapStatus = ({
  status,
  grid,
  colors,
  accessibleSummary,
  weekdayRows,
  describeCell,
}: {
  status: DailyActivityStatus;
  grid: ActivityGrid;
  colors: HeatmapColors;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
}) => {
  const intl = useIntl();
  const theme = useTheme();

  if (status === "loading" || status === "idle") {
    return (
      <LinearProgress
        aria-label={intl.formatMessage({
          defaultMessage: "Loading daily activity",
        })}
      />
    );
  }
  if (status === "error") {
    return (
      <Typography
        role="status"
        variant="body2"
        sx={{ color: "text.secondary", py: theme.spacing(2) }}
      >
        <FormattedMessage defaultMessage="Daily activity could not be loaded." />
      </Typography>
    );
  }
  return (
    <ActivityHeatmapGrid
      grid={grid}
      colors={colors}
      accessibleSummary={accessibleSummary}
      weekdayRows={weekdayRows}
      describeCell={describeCell}
    />
  );
};

const AccessibleActivityList = ({
  cells,
  describeCell,
  intl,
}: {
  cells: ActivityGridCell[];
  describeCell: CellDescription;
  intl: ReturnType<typeof useIntl>;
}) => (
  <Box
    component="ol"
    aria-label={intl.formatMessage({ defaultMessage: "Daily word counts" })}
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
    {cells.map((cell) => (
      <li key={cell.localDate}>
        {describeCell(cell.localDate, cell.wordCount)}
      </li>
    ))}
  </Box>
);

const ActivityHeatmapResults = ({
  status,
  grid,
  colors,
  accessibleSummary,
  weekdayRows,
  describeCell,
  visibleCells,
  activeDays,
}: {
  status: DailyActivityStatus;
  grid: ActivityGrid;
  colors: HeatmapColors;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
  visibleCells: ActivityGridCell[];
  activeDays: number;
}) => {
  const theme = useTheme();
  const intl = useIntl();

  return (
    <>
      <ActivityHeatmapStatus
        status={status}
        grid={grid}
        colors={colors}
        accessibleSummary={accessibleSummary}
        weekdayRows={weekdayRows}
        describeCell={describeCell}
      />
      {status === "success" ? (
        <AccessibleActivityList
          cells={visibleCells}
          describeCell={describeCell}
          intl={intl}
        />
      ) : null}
      {status === "success" && activeDays === 0 ? (
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", mt: theme.spacing(1) }}
        >
          <FormattedMessage defaultMessage="Your dictation activity will appear here." />
        </Typography>
      ) : null}
    </>
  );
};

const ActivityHeatmapLegend = ({ colors }: { colors: HeatmapColors }) => {
  const intl = useIntl();
  const theme = useTheme();

  return (
    <Stack
      role="group"
      direction="row"
      spacing={0.75}
      sx={{
        justifyContent: "flex-end",
        alignItems: "center",
        mt: theme.spacing(2.25),
      }}
      aria-label={intl.formatMessage({
        defaultMessage: "Activity level legend",
      })}
    >
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontFamily: "var(--font-data)",
          fontSize: 9,
          lineHeight: 1,
        }}
      >
        <FormattedMessage defaultMessage="Less" />
      </Typography>
      {colors.map((color) => (
        <Box
          key={color}
          aria-hidden="true"
          sx={{
            width: activityHeatmapGeometry.cellSize,
            height: activityHeatmapGeometry.cellSize,
            borderRadius: 0.15,
            bgcolor: color,
          }}
        />
      ))}
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontFamily: "var(--font-data)",
          fontSize: 9,
          lineHeight: 1,
        }}
      >
        <FormattedMessage defaultMessage="More" />
      </Typography>
    </Stack>
  );
};

export const ActivityHeatmap = ({
  activity,
  status,
  today,
}: ActivityHeatmapProps) => {
  const intl = useIntl();
  const grid = useMemo(
    () => buildActivityGrid(activity, today),
    [activity, today],
  );
  const palette = useIsDarkMode()
    ? activityHeatmap.dark
    : activityHeatmap.light;
  const colors: HeatmapColors = [palette[0], palette[1], palette[4]];
  const { visibleCells, activeDays, totalWords } = useMemo(
    () => summarizeActivityGrid(grid),
    [grid],
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
  const describeCell: CellDescription = (localDate, wordCount) =>
    intl.formatMessage(
      {
        defaultMessage:
          "{date, date, medium}: {wordCount, plural, one {# word} other {# words}}",
      },
      { date: dateFromLocalDateKey(localDate), wordCount },
    );
  const weekdayRows = makeWeekdayRows(intl);

  return (
    <Box
      component="section"
      aria-labelledby="home-activity-heading"
      data-testid="home-activity-heatmap"
      sx={{
        minWidth: 0,
        pt: 0,
        "@container home-page (min-width: 560px)": {
          pt: `${activityHeatmapGeometry.desktopTopPadding}px`,
        },
      }}
    >
      <ActivityHeatmapHeader
        status={status}
        activeDaysLabel={activeDaysLabel}
      />
      <ActivityHeatmapResults
        status={status}
        grid={grid}
        colors={colors}
        accessibleSummary={accessibleSummary}
        weekdayRows={weekdayRows}
        describeCell={describeCell}
        visibleCells={visibleCells}
        activeDays={activeDays}
      />
      <ActivityHeatmapLegend colors={colors} />
    </Box>
  );
};
