/**
 * The figures in the visual guides, captured from the running desktop app.
 *
 * Every entry is a screenshot of the product itself: `route` is the app route
 * the window shows and `root` the element the shot is cropped to. Nothing here
 * redraws a surface, so a figure cannot drift from the interface it documents.
 *
 * `markers` are the numbered badges the guide's annotation list refers to. A
 * selector must match exactly one element inside the root unless `pick` says
 * which match to use, so a renamed component fails the capture instead of
 * drawing a badge on the wrong element.
 *
 * `prepare` runs in the page before the crop, for a figure that needs a surface
 * opened or a panel scrolled into view first.
 */
const contentColumn = { x: 496, y: 96, width: 596, height: 596 };

const settings = (page, extra = {}) => ({
  route: `/dashboard/settings/${page}`,
  root: "main",
  rect: contentColumn,
  ...extra,
});

export const APP_FIGURES = {
  "home-heatmap": {
    route: "/dashboard",
    root: '[data-testid="home-analytics-grid"]',
    padding: { top: 34, right: 40, bottom: 24, left: 40 },
    markers: [
      { n: 1, selector: '[data-testid="activity-heatmap-labels"]', placement: "start" },
      {
        n: 2,
        selector: '[data-testid="activity-day"]:not([data-intensity="0"])',
        pick: "middle",
        placement: "above",
      },
      { n: 3, selector: '[data-home-grid-area="streak"]', placement: "start" },
      { n: 4, selector: '[data-home-grid-area="total"]', placement: "start" },
    ],
  },
  "home-week": {
    route: "/dashboard",
    root: '[data-testid="home-activity-heatmap"]',
    padding: 16,
  },
  "home-summary": {
    route: "/dashboard",
    root: '[data-home-grid-area="total"]',
    padding: 20,
  },
  "dictation-controls": settings("dictation"),
  "dictation-delivery": settings("dictation", { scrollText: "Output" }),
  "ai-models": settings("ai-models"),
  "shortcuts": settings("shortcuts"),
  "appearance": settings("appearance"),
  "privacy-data": settings("privacy-data"),
  "assistant-chats": {
    route: "/dashboard/chats",
    root: "main",
    padding: 0,
    prepare: `(() => {
      const item = [...document.querySelectorAll('[role="button"], [role="option"], li')]
        .find((node) => node.textContent.includes("Release notes for 0.1.6"));
      if (item) item.click();
      return true;
    })()`,
    waitText: "Summarise this week",
  },
  "history-list": {
    route: "/dashboard/transcriptions",
    root: "main",
    padding: 0,
  },
  "dictionary-list": {
    route: "/dashboard/dictionary",
    root: "main",
    padding: 0,
  },
  "styles-list": {
    route: "/dashboard/styling",
    root: "main",
    padding: 0,
  },
};
