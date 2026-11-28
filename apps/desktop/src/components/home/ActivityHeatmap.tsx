import {
  Box,
  Stack,
  Tooltip,
  type TooltipProps,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { keyframes } from "@mui/material/styles";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
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
import { visuallyHidden } from "../../styles/a11y";
import { activityHeatmap, activityHeatmapSkeleton } from "../../styles/palette";
import { activityHeatmapGeometry } from "../../styles/activity-heatmap";
import {
  cssEase,
  duration,
  easeOutQuint,
  reducedMotionQuery,
  skeletonPulse,
} from "../../styles/motion";
import { useIsDarkMode } from "../../hooks/color-scheme.hooks";

const MS_PER_SECOND = 1000;
const HEATMAP_TOOLTIP_ENTER_MS = Math.round(duration.instant * MS_PER_SECOND);
const CELL_BORDER_RADIUS = 0.15;
const LEGEND_LABEL_PLACEHOLDER_HEIGHT = 6;
const LEGEND_LABEL_SX = {
  fontFamily: "var(--font-data)",
  fontSize: 9,
  lineHeight: 1,
} as const;
const SKELETON_FUTURE_CELL_SX = {
  width: activityHeatmapGeometry.cellSize,
  height: activityHeatmapGeometry.cellSize,
  borderRadius: CELL_BORDER_RADIUS,
  bgcolor: "transparent",
  pointerEvents: "none" as const,
} as const;

const skeletonBreath = keyframes`
  0%, 100% {
    opacity: ${skeletonPulse.maxOpacity};
  }
  50% {
    opacity: ${skeletonPulse.minOpacity};
  }
`;

type HeatmapColors = readonly string[];
type HeatmapPresentation = "skeleton" | "error" | "ready";
type SettledActivityStatus = Exclude<DailyActivityStatus, "loading">;
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

const resolveHeatmapPresentation = (
  status: DailyActivityStatus,
  hasActivityData: boolean,
  lastSettledStatus: SettledActivityStatus,
): HeatmapPresentation => {
  if (status === "error") return "error";
  if (status === "success") return "ready";
  if (status === "idle") return "skeleton";
  // Keep an already-rendered heatmap visible during refreshes rather than
  // flashing a skeleton over cached data; retries after an error still load via
  // the skeleton.
  if (lastSettledStatus === "success") return "ready";
  if (lastSettledStatus === "idle" && hasActivityData) return "ready";
  return "skeleton";
};

const useHeatmapPresentation = (
  status: DailyActivityStatus,
  hasActivityData: boolean,
): HeatmapPresentation => {
  const [lastSettledStatus, setLastSettledStatus] =
    useState<SettledActivityStatus>(status === "loading" ? "idle" : status);

  useLayoutEffect(() => {
    if (status !== "loading") {
      setLastSettledStatus(status);
    }
  }, [status]);

  return resolveHeatmapPresentation(status, hasActivityData, lastSettledStatus);
};

const heatmapGridSx = (weekCount: number) => ({
  display: "grid",
  gridTemplateColumns: `repeat(${weekCount}, ${activityHeatmapGeometry.cellSize}px)`,
  gridTemplateRows: `repeat(7, ${activityHeatmapGeometry.cellSize}px)`,
  columnGap: `${activityHeatmapGeometry.cellGap}px`,
  rowGap: `${activityHeatmapGeometry.cellGap}px`,
  alignItems: "center",
});

const skeletonPulseSx = (prefersReducedMotion: boolean) => ({
  opacity: skeletonPulse.maxOpacity,
  animation: prefersReducedMotion
    ? "none"
    : `${skeletonBreath} ${skeletonPulse.duration}s ${cssEase(skeletonPulse.ease)} infinite`,
  "@media (prefers-reduced-motion: reduce)": {
    animation: "none",
  },
});

const useLatestWeekScroll = (endDate: string) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followsLatestWeek = useRef(true);

  // Keep recent weeks visible on load and after responsive resizing, without
  // pulling readers back after they scroll into older history.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const keepLatestWeekVisible = () => {
      if (!followsLatestWeek.current) return;
      viewport.scrollLeft = Math.max(
        0,
        viewport.scrollWidth - viewport.clientWidth,
      );
    };

    keepLatestWeekVisible();
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(keepLatestWeekVisible);
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, [endDate]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    followsLatestWeek.current =
      viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
  };

  return { viewportRef, handleScroll };
};

const ActivityHeatmapWeekdayRail = ({
  weekdayRows,
}: {
  weekdayRows: WeekdayRow[];
}) => {
  const theme = useTheme();

  return (
    <Box
      aria-hidden="true"
      data-testid="activity-heatmap-labels"
      sx={{
        flex: `0 0 ${activityHeatmapGeometry.labelColumnWidth}px`,
        display: "grid",
        gridTemplateRows: `repeat(7, ${activityHeatmapGeometry.cellSize}px)`,
        rowGap: `${activityHeatmapGeometry.cellGap}px`,
        alignItems: "center",
        // Start the rail on the first row of the plot, not on the room the
        // viewport reserves above it for the top row's hover treatment.
        pt: `${activityHeatmapGeometry.cellHoverReach}px`,
        "@container home-page (min-width: 560px)": {
          flex: `0 0 ${activityHeatmapGeometry.desktopLabelColumnWidth}px`,
        },
      }}
    >
      {weekdayRows.map(({ localDate, label, gridRow, visible }) => (
        <Typography
          key={localDate}
          aria-hidden="true"
          variant="caption"
          sx={{
            gridRow,
            color: "text.secondary",
            fontFamily: "var(--font-data)",
            fontSize: 9,
            lineHeight: `${activityHeatmapGeometry.cellSize}px`,
            textAlign: "right",
            pr: theme.spacing(0.5),
            visibility: visible ? "visible" : "hidden",
          }}
        >
          {label}
        </Typography>
      ))}
    </Box>
  );
};

const ActivityHeatmapFrame = ({
  weekdayRows,
  endDate,
  interactive,
  children,
}: {
  weekdayRows: WeekdayRow[];
  endDate: string;
  interactive: boolean;
  children: ReactNode;
}) => {
  const { viewportRef, handleScroll } = useLatestWeekScroll(endDate);

  return (
    <Box
      aria-hidden={interactive ? undefined : true}
      data-testid="activity-heatmap-layout"
      sx={{
        display: "flex",
        minWidth: 0,
        columnGap: `${activityHeatmapGeometry.cellGap}px`,
      }}
    >
      <ActivityHeatmapWeekdayRail weekdayRows={weekdayRows} />
      <Box
        ref={viewportRef}
        role={interactive ? "region" : undefined}
        aria-labelledby={interactive ? "home-activity-heading" : undefined}
        tabIndex={interactive ? 0 : undefined}
        data-testid="activity-heatmap-viewport"
        onScroll={handleScroll}
        sx={{
          flex: "1 1 auto",
          minWidth: 0,
          overflowX: "auto",
          // A box that scrolls horizontally cannot leave the cross axis
          // visible, so name the clip instead of letting the browser compute
          // it, and reserve the room a grown cell needs on every edge.
          overflowY: "clip",
          p: `${activityHeatmapGeometry.cellHoverReach}px`,
        }}
      >
        <Box
          sx={{
            minWidth: activityHeatmapGeometry.dayGridWidth,
            width: "max-content",
            mx: "auto",
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};

const ActivityHeatmapHeader = ({
  isReady,
  activeDaysLabel,
}: {
  isReady: boolean;
  activeDaysLabel: string;
}) => (
  <Box sx={visuallyHidden}>
    <Typography id="home-activity-heading">
      <FormattedMessage defaultMessage="Daily activity" />
    </Typography>
    <Typography>
      <FormattedMessage defaultMessage="Words dictated over the past year" />
    </Typography>
    {isReady ? <Typography>{activeDaysLabel}</Typography> : null}
  </Box>
);

const ActivityHeatmapSkeleton = ({
  grid,
  weekdayRows,
  skeletonColor,
  prefersReducedMotion,
}: {
  grid: ActivityGrid;
  weekdayRows: WeekdayRow[];
  skeletonColor: string;
  prefersReducedMotion: boolean;
}) => {
  const intl = useIntl();
  // Keep grid placement in inline styles so all 371 placeholder cells share
  // two Emotion classes instead of generating a class per coordinate.
  const cellSx = useMemo(
    () => ({
      width: activityHeatmapGeometry.cellSize,
      height: activityHeatmapGeometry.cellSize,
      borderRadius: CELL_BORDER_RADIUS,
      bgcolor: skeletonColor,
      pointerEvents: "none" as const,
    }),
    [skeletonColor],
  );

  return (
    <Box
      role="status"
      aria-label={intl.formatMessage({
        defaultMessage: "Loading daily activity",
      })}
      data-testid="activity-heatmap-skeleton"
    >
      <ActivityHeatmapFrame
        weekdayRows={weekdayRows}
        endDate={grid.endDate}
        interactive={false}
      >
        <Box
          data-testid="activity-heatmap-skeleton-grid"
          sx={{
            ...heatmapGridSx(grid.weeks.length),
            ...skeletonPulseSx(prefersReducedMotion),
          }}
        >
          {grid.weeks.flatMap((week, weekIndex) =>
            week.map((cell, dayIndex) => (
              <Box
                key={cell.localDate}
                aria-hidden="true"
                data-future={cell.isFuture ? "true" : undefined}
                data-testid="activity-heatmap-skeleton-cell"
                style={{
                  gridColumn: weekIndex + 1,
                  gridRow: dayIndex + 1,
                }}
                sx={cell.isFuture ? SKELETON_FUTURE_CELL_SX : cellSx}
              />
            )),
          )}
        </Box>
      </ActivityHeatmapFrame>
    </Box>
  );
};

const ActivityHeatmapGrid = ({
  grid,
  colors,
  accessibleSummary,
  weekdayRows,
  describeCell,
  prefersReducedMotion,
}: {
  grid: ActivityGrid;
  colors: HeatmapColors;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
  prefersReducedMotion: boolean;
}) => {
  const theme = useTheme();

  // Heatmap cells are 10px squares, so the tooltip sits over neighboring rows.
  // Non-interactive poppers with instant exit keep pointer sweeps unobstructed.
  const tooltipSlotProps = useMemo<TooltipProps["slotProps"]>(
    () => ({
      tooltip: { sx: { fontFamily: "var(--font-data)" } },
      transition: {
        exit: false,
        timeout: {
          enter: prefersReducedMotion ? 0 : HEATMAP_TOOLTIP_ENTER_MS,
        },
      },
    }),
    [prefersReducedMotion],
  );

  return (
    <ActivityHeatmapFrame
      weekdayRows={weekdayRows}
      endDate={grid.endDate}
      interactive
    >
      <Box
        role="img"
        aria-label={accessibleSummary}
        sx={heatmapGridSx(grid.weeks.length)}
      >
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
              disableInteractive
              disableHoverListener={cell.isFuture}
              enterDelay={0}
              enterNextDelay={0}
              leaveDelay={0}
              slotProps={tooltipSlotProps}
            >
              <Box
                aria-hidden="true"
                data-date={cell.localDate}
                data-word-count={cell.wordCount}
                data-intensity={cell.intensity}
                data-testid="activity-day"
                sx={{
                  gridColumn: weekIndex + 1,
                  gridRow: dayIndex + 1,
                  width: activityHeatmapGeometry.cellSize,
                  height: activityHeatmapGeometry.cellSize,
                  borderRadius: CELL_BORDER_RADIUS,
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
                          transform: `scale(${activityHeatmapGeometry.cellHoverScale})`,
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
    </ActivityHeatmapFrame>
  );
};

const ActivityHeatmapStatus = ({
  presentation,
  grid,
  colors,
  skeletonColor,
  accessibleSummary,
  weekdayRows,
  describeCell,
  prefersReducedMotion,
}: {
  presentation: HeatmapPresentation;
  grid: ActivityGrid;
  colors: HeatmapColors;
  skeletonColor: string;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
  prefersReducedMotion: boolean;
}) => {
  const theme = useTheme();

  if (presentation === "skeleton") {
    return (
      <ActivityHeatmapSkeleton
        grid={grid}
        weekdayRows={weekdayRows}
        skeletonColor={skeletonColor}
        prefersReducedMotion={prefersReducedMotion}
      />
    );
  }
  if (presentation === "error") {
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
      prefersReducedMotion={prefersReducedMotion}
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
    sx={visuallyHidden}
  >
    {cells.map((cell) => (
      <li key={cell.localDate}>
        {describeCell(cell.localDate, cell.wordCount)}
      </li>
    ))}
  </Box>
);

const ActivityHeatmapResults = ({
  presentation,
  grid,
  colors,
  skeletonColor,
  accessibleSummary,
  weekdayRows,
  describeCell,
  visibleCells,
  activeDays,
  prefersReducedMotion,
}: {
  presentation: HeatmapPresentation;
  grid: ActivityGrid;
  colors: HeatmapColors;
  skeletonColor: string;
  accessibleSummary: string;
  weekdayRows: WeekdayRow[];
  describeCell: CellDescription;
  visibleCells: ActivityGridCell[];
  activeDays: number;
  prefersReducedMotion: boolean;
}) => {
  const theme = useTheme();
  const intl = useIntl();
  const isReady = presentation === "ready";

  return (
    <>
      <ActivityHeatmapStatus
        presentation={presentation}
        grid={grid}
        colors={colors}
        skeletonColor={skeletonColor}
        accessibleSummary={accessibleSummary}
        weekdayRows={weekdayRows}
        describeCell={describeCell}
        prefersReducedMotion={prefersReducedMotion}
      />
      {isReady ? (
        <AccessibleActivityList
          cells={visibleCells}
          describeCell={describeCell}
          intl={intl}
        />
      ) : null}
      {isReady && activeDays === 0 ? (
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

const LegendLabelSkeleton = ({
  skeletonColor,
  children,
}: {
  skeletonColor: string;
  children: ReactNode;
}) => (
  <Box
    component="span"
    aria-hidden="true"
    data-testid="activity-heatmap-legend-label-skeleton"
    sx={{
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
    }}
  >
    <Typography
      component="span"
      variant="caption"
      sx={{
        ...LEGEND_LABEL_SX,
        visibility: "hidden",
        userSelect: "none",
      }}
    >
      {children}
    </Typography>
    <Box
      component="span"
      data-testid="activity-heatmap-legend-label-skeleton-bar"
      sx={{
        position: "absolute",
        insetInline: 0,
        height: LEGEND_LABEL_PLACEHOLDER_HEIGHT,
        borderRadius: CELL_BORDER_RADIUS,
        bgcolor: skeletonColor,
      }}
    />
  </Box>
);

const ActivityHeatmapLegendSkeleton = ({
  swatchKeys,
  skeletonColor,
  prefersReducedMotion,
}: {
  swatchKeys: HeatmapColors;
  skeletonColor: string;
  prefersReducedMotion: boolean;
}) => {
  const theme = useTheme();

  return (
    <Stack
      aria-hidden="true"
      data-testid="activity-heatmap-legend-skeleton"
      direction="row"
      spacing={0.75}
      sx={{
        justifyContent: "flex-end",
        alignItems: "center",
        mt: theme.spacing(2.25),
        ...skeletonPulseSx(prefersReducedMotion),
      }}
    >
      <LegendLabelSkeleton skeletonColor={skeletonColor}>
        <FormattedMessage defaultMessage="Less" />
      </LegendLabelSkeleton>
      {swatchKeys.map((swatchKey) => (
        <Box
          key={swatchKey}
          data-testid="activity-heatmap-legend-swatch-skeleton"
          sx={{
            width: activityHeatmapGeometry.cellSize,
            height: activityHeatmapGeometry.cellSize,
            borderRadius: CELL_BORDER_RADIUS,
            bgcolor: skeletonColor,
          }}
        />
      ))}
      <LegendLabelSkeleton skeletonColor={skeletonColor}>
        <FormattedMessage defaultMessage="More" />
      </LegendLabelSkeleton>
    </Stack>
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
          ...LEGEND_LABEL_SX,
          color: "text.secondary",
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
            borderRadius: CELL_BORDER_RADIUS,
            bgcolor: color,
          }}
        />
      ))}
      <Typography
        variant="caption"
        sx={{
          ...LEGEND_LABEL_SX,
          color: "text.secondary",
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
  const isDark = useIsDarkMode();
  const prefersReducedMotion = useMediaQuery(reducedMotionQuery);
  const presentation = useHeatmapPresentation(status, activity.length > 0);
  const isSkeleton = presentation === "skeleton";
  const grid = useMemo(
    () => buildActivityGrid(activity, today),
    [activity, today],
  );
  const palette = isDark ? activityHeatmap.dark : activityHeatmap.light;
  const skeletonColor = isDark
    ? activityHeatmapSkeleton.dark
    : activityHeatmapSkeleton.light;
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
  const weekdayRows = useMemo(() => makeWeekdayRows(intl), [intl]);

  return (
    <Box
      component="section"
      aria-labelledby="home-activity-heading"
      aria-busy={isSkeleton ? true : undefined}
      data-testid="home-activity-heatmap"
      sx={{
        minWidth: 0,
        pt: 0,
        "@container home-page (min-width: 560px)": {
          pt: `${activityHeatmapGeometry.desktopTopPadding}px`,
          pr: `${activityHeatmapGeometry.desktopRightInset}px`,
        },
      }}
    >
      <ActivityHeatmapHeader
        isReady={presentation === "ready"}
        activeDaysLabel={activeDaysLabel}
      />
      <ActivityHeatmapResults
        presentation={presentation}
        grid={grid}
        colors={colors}
        skeletonColor={skeletonColor}
        accessibleSummary={accessibleSummary}
        weekdayRows={weekdayRows}
        describeCell={describeCell}
        visibleCells={visibleCells}
        activeDays={activeDays}
        prefersReducedMotion={prefersReducedMotion}
      />
      {isSkeleton ? (
        <ActivityHeatmapLegendSkeleton
          swatchKeys={colors}
          skeletonColor={skeletonColor}
          prefersReducedMotion={prefersReducedMotion}
        />
      ) : (
        <ActivityHeatmapLegend colors={colors} />
      )}
    </Box>
  );
};
