import {
  Box,
  Button,
  Container,
  Stack,
  Typography,
  type ContainerProps,
  type SxProps,
  type Theme,
} from "@mui/material";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FormattedMessage } from "react-intl";
import {
  COLLAPSE_ANIM_ATTR,
  COLLAPSING_ATTR,
  INITIAL_HEADER_METRICS,
  attachScrollListCollapse,
  collapseSpacerExpr,
  headerHeightExpr,
  measureHeaderMetrics,
  sameHeaderMetrics,
  titleHeightExpr,
  titleScaleRange,
  type HeaderMetrics,
  type ScrollListCollapseHandle,
} from "./scrollListCollapse";

export type ScrollListPageProps<Item> = {
  title: ReactNode;
  action?: ReactNode;
  subtitle?: ReactNode;
  items: readonly Item[];
  renderItem: (item: Item, index: number) => ReactNode;
  computeItemKey?: (item: Item, index: number) => string | number;
  headerMaxWidth?: ContainerProps["maxWidth"];
  contentMaxWidth?: ContainerProps["maxWidth"];
  itemWrapperSx?: SxProps<Theme>;
  itemContainerSx?: SxProps<Theme>;
  emptyState?: ReactNode;
  hasMore?: boolean;
  onLoadMore?: () => void;
};

export function ScrollListPage<Item>({
  title,
  action,
  subtitle,
  items,
  renderItem,
  computeItemKey,
  headerMaxWidth = "sm",
  contentMaxWidth = "sm",
  itemWrapperSx,
  itemContainerSx,
  emptyState,
  hasMore,
  onLoadMore,
}: ScrollListPageProps<Item>) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const expandedHeaderMeasureRef = useRef<HTMLDivElement>(null);
  const collapsedHeaderMeasureRef = useRef<HTMLDivElement>(null);
  const expandedTitleMeasureRef = useRef<HTMLSpanElement>(null);
  const collapsedTitleMeasureRef = useRef<HTMLSpanElement>(null);
  const [headerMetrics, setHeaderMetrics] = useState<HeaderMetrics>(
    INITIAL_HEADER_METRICS,
  );
  const collapseRef = useRef<ScrollListCollapseHandle | null>(null);
  const hasItems = items.length > 0;
  const hasResizeObserver = typeof ResizeObserver !== "undefined";

  useLayoutEffect(() => {
    if (!hasItems) {
      collapseRef.current = null;
      return;
    }

    const scroller = scrollerRef.current;
    const expandedHeader = expandedHeaderMeasureRef.current;
    const collapsedHeader = collapsedHeaderMeasureRef.current;
    const expandedTitle = expandedTitleMeasureRef.current;
    const collapsedTitle = collapsedTitleMeasureRef.current;
    if (
      !scroller ||
      !expandedHeader ||
      !collapsedHeader ||
      !expandedTitle ||
      !collapsedTitle
    ) {
      return;
    }

    const handle = attachScrollListCollapse({
      scroller,
      measureElements: [
        expandedHeader,
        collapsedHeader,
        expandedTitle,
        collapsedTitle,
      ],
      readMetrics: () =>
        measureHeaderMetrics({
          expandedHeader: expandedHeader.getBoundingClientRect().height,
          collapsedHeader: collapsedHeader.getBoundingClientRect().height,
          expandedTitle: expandedTitle.getBoundingClientRect().height,
          collapsedTitle: collapsedTitle.getBoundingClientRect().height,
        }),
      onMetrics: (next) => {
        setHeaderMetrics((current) =>
          sameHeaderMetrics(current, next) ? current : next,
        );
      },
    });
    collapseRef.current = handle;
    return () => {
      handle.disconnect();
      if (collapseRef.current === handle) {
        collapseRef.current = null;
      }
    };
  }, [hasItems]);

  // No ResizeObserver: re-measure after each commit so title/action/width
  // changes still update collapse geometry without rebinding the scroll listener.
  useLayoutEffect(() => {
    if (hasResizeObserver) {
      return;
    }
    collapseRef.current?.refresh();
  });

  const handleLoadMore = useCallback(() => {
    onLoadMore?.();
  }, [onLoadMore]);
  const scaleRange = titleScaleRange(headerMetrics.titleScale);
  const headerHeight = headerHeightExpr(headerMetrics);
  const titleHeight = titleHeightExpr(headerMetrics);
  const collapseSpacer = collapseSpacerExpr(headerMetrics.collapseDistance);

  return (
    <Box
      sx={{
        position: "relative",
        flexGrow: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {items.length === 0 ? (
        <>
          <Box
            sx={(theme) => ({
              pr: 2,
              // The page canvas is `level0` (PageLayout), so the sticky header
              // band must sit on the same tier or it reads as an off-colour
              // seam over the list content.
              backgroundColor:
                theme.vars?.palette.level0 ?? theme.palette.background.default,
              position: "sticky",
              top: 0,
              zIndex: theme.zIndex.appBar,
            })}
          >
            <Container maxWidth={headerMaxWidth} sx={{ pt: 1, pb: 4 }}>
              <Stack spacing={1.5}>
                <Stack
                  direction="row"
                  spacing={2}
                  sx={{
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                  }}
                >
                  <Typography
                    variant="h4"
                    sx={{
                      fontWeight: 700,
                    }}
                  >
                    {title}
                  </Typography>
                  {action}
                </Stack>
                {subtitle ? (
                  <Typography
                    variant="subtitle1"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {subtitle}
                  </Typography>
                ) : null}
              </Stack>
            </Container>
          </Box>
          <Box
            sx={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "auto",
            }}
          >
            <Container maxWidth={contentMaxWidth} sx={{ pb: 8 }}>
              {emptyState || (
                <Stack
                  spacing={1}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  <Typography
                    variant="h6"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    It's quiet in here
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    There are no items to display.
                  </Typography>
                </Stack>
              )}
            </Container>
          </Box>
        </>
      ) : (
        <Box
          ref={scrollerRef}
          sx={{
            "--p": 0,
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
            [`&[${COLLAPSING_ATTR}]`]: {
              overflowAnchor: "none",
            },
            [`&[${COLLAPSING_ATTR}] [${COLLAPSE_ANIM_ATTR}]`]: {
              willChange: "transform, opacity",
            },
          }}
        >
          <Box
            sx={(theme) => ({
              pr: 2,
              backgroundColor:
                theme.vars?.palette.level0 ?? theme.palette.background.default,
              position: "sticky",
              top: 0,
              zIndex: theme.zIndex.appBar,
              height: headerHeight,
              overflow: "hidden",
              overflowAnchor: "none",
            })}
          >
            <Container maxWidth={headerMaxWidth} sx={{ pt: 1, pb: 4 }}>
              <Stack spacing={1.5}>
                <Stack
                  direction="row"
                  spacing={2}
                  sx={{
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                  }}
                >
                  <Box sx={{ height: titleHeight, flex: 1, minWidth: 0 }}>
                    <Typography
                      component="span"
                      variant="h5"
                      data-scroll-list-collapse-anim=""
                      sx={{
                        fontWeight: 700,
                        display: "block",
                        transformOrigin: "top left",
                        transform: `scale(calc(1 + ${scaleRange} * (1 - var(--p, 0))))`,
                      }}
                    >
                      {title}
                    </Typography>
                  </Box>
                  {action}
                </Stack>
                {subtitle ? (
                  <Typography
                    variant="subtitle1"
                    data-scroll-list-collapse-anim=""
                    sx={{
                      color: "text.secondary",
                      opacity: "clamp(0, calc(1 - var(--p, 0) * 2), 1)",
                      transformOrigin: "top left",
                      transform:
                        "scale(calc(1 - 0.1 * var(--p, 0))) translateY(calc(-4px * var(--p, 0)))",
                    }}
                  >
                    {subtitle}
                  </Typography>
                ) : null}
              </Stack>
            </Container>
          </Box>
          {items.map((item, index) => (
            <Container
              key={computeItemKey ? computeItemKey(item, index) : index}
              maxWidth={contentMaxWidth}
              sx={itemContainerSx}
            >
              <Box sx={itemWrapperSx}>{renderItem(item, index)}</Box>
            </Container>
          ))}
          {hasMore && (
            <Container maxWidth={contentMaxWidth}>
              <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                <Button variant="text" onClick={handleLoadMore}>
                  <FormattedMessage defaultMessage="Show more" />
                </Button>
              </Box>
            </Container>
          )}
          <Box sx={{ height: 32 }} />
          {collapseSpacer ? (
            <Box
              aria-hidden
              // Grows by the same amount the sticky header shrinks so
              // scrollHeight stays constant. Without this, mid-collapse
              // scrollTop is re-clamped and --p oscillates.
              sx={{
                height: collapseSpacer,
                flexShrink: 0,
                pointerEvents: "none",
                overflowAnchor: "none",
              }}
            />
          ) : null}
        </Box>
      )}
      {items.length > 0 ? (
        <Box
          aria-hidden
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            visibility: "hidden",
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          <Container
            maxWidth={headerMaxWidth}
            ref={expandedHeaderMeasureRef}
            sx={{ pt: 1, pb: 4 }}
          >
            <Stack spacing={1.5}>
              <Stack
                direction="row"
                spacing={2}
                sx={{
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                }}
              >
                <Typography
                  component="span"
                  ref={expandedTitleMeasureRef}
                  variant="h4"
                  sx={{
                    fontWeight: 700,
                    display: "block",
                  }}
                >
                  {title}
                </Typography>
                {action}
              </Stack>
              {subtitle ? (
                <Typography
                  variant="subtitle1"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {subtitle}
                </Typography>
              ) : null}
            </Stack>
          </Container>
          <Container
            maxWidth={headerMaxWidth}
            ref={collapsedHeaderMeasureRef}
            sx={{ pt: 1, pb: 1 }}
          >
            <Stack
              direction="row"
              spacing={2}
              sx={{
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <Typography
                component="span"
                ref={collapsedTitleMeasureRef}
                variant="h5"
                sx={{
                  fontWeight: 700,
                  display: "block",
                }}
              >
                {title}
              </Typography>
              {action}
            </Stack>
          </Container>
        </Box>
      ) : null}
    </Box>
  );
}
