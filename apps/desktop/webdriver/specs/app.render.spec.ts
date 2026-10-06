import { browser, expect } from "@wdio/globals";

type ViewportMetrics = {
  width: number;
  documentWidth: number;
  bodyWidth: number;
  contentRight: number;
};

const homeAnalytics = () => browser.$('section[aria-label="Home analytics"]');
const activityGrid = () => browser.$('[role="grid"]');

const openScenario = async (scenario: string) => {
  await browser.url(`/dashboard?scenario=${scenario}`);
  const analytics = homeAnalytics();
  await analytics.waitForDisplayed({ timeout: 15000 });
  return analytics;
};

const previewOnly = (title: string, test: () => Promise<void>) =>
  it(title, async function () {
    const selector = await browser.$('[aria-label="Preview scenario"]');
    if (!(await selector.isExisting())) this.skip();
    await test();
  });

const viewportMetrics = () =>
  browser.execute((): ViewportMetrics => {
    const content = document.querySelector<HTMLElement>(".MuiContainer-root");
    return {
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      contentRight: content?.getBoundingClientRect().right ?? 0,
    };
  });

describe("mausVoice desktop bootstrap", () => {
  it("renders the application shell", async () => {
    const root = await browser.$("#root");
    await root.waitForExist({ timeout: 15000 });

    const renderedChildren = await root.$$(":scope > *");
    expect(renderedChildren.length).toBeGreaterThan(0);

    const progressIndicator = await browser.$('[role="progressbar"]');
    if (await progressIndicator.isExisting()) {
      expect(await progressIndicator.isDisplayed()).toBe(true);
    }
  });
});

describe("Home analytics in the browser preview", () => {
  previewOnly(
    "shows populated reference metrics and a single keyboard-operable calendar",
    async () => {
      const analytics = await openScenario("populated");
      const selector = await browser.$('[aria-label="Preview scenario"]');
      expect(await selector.isExisting()).toBe(true);

      const metricCards = await analytics.$$(".MuiCard-root");
      const metricText = await metricCards.map((card) => card.getText());
      expect(
        metricText.some(
          (text) => text.includes("Day streak") && text.includes("1"),
        ),
      ).toBe(true);
      expect(
        metricText.some(
          (text) => text.includes("Words this month") && text.includes("127"),
        ),
      ).toBe(true);
      expect(
        metricText.some(
          (text) => text.includes("Lifetime words") && text.includes("14,323"),
        ),
      ).toBe(true);
      expect(metricText.some((text) => text.includes("73 WPM"))).toBe(true);
      expect(
        metricText.some((text) => text.includes("3 recent dictations")),
      ).toBe(true);

      const grid = activityGrid();
      await grid.waitForDisplayed({ timeout: 15000 });
      const cells = await grid.$$('[role="gridcell"]');
      expect(cells.length).toBeGreaterThan(150);
      expect(
        await browser.execute(
          () => document.querySelectorAll('[role="gridcell"][tabindex]').length,
        ),
      ).toBe(0);

      const initialActiveId = await grid.getAttribute("aria-activedescendant");
      expect(initialActiveId).toBeTruthy();
      const activeCellLabel = await browser.execute(
        (id: string) => document.getElementById(id)?.getAttribute("aria-label"),
        initialActiveId!,
      );
      expect(activeCellLabel).toMatch(/^Saved words for .+: [\d,.]+$/);

      await grid.click();
      await browser.keys("ArrowLeft");
      const movedActiveId = await grid.getAttribute("aria-activedescendant");
      expect(movedActiveId).not.toBe(initialActiveId);

      const detailsButton = await browser.$(
        '//button[contains(., "View activity details")]',
      );
      await detailsButton.click();
      const detailsTable = await browser.$(
        '[aria-label="Daily saved-word details"]',
      );
      await detailsTable.waitForDisplayed({ timeout: 5000 });
      const currentDate = activeCellLabel?.match(
        /^Saved words for (.*): /,
      )?.[1];
      expect(await detailsTable.getText()).toContain(currentDate);
    },
  );

  previewOnly(
    "keeps the WPM empty state, an empty history, and a query failure distinct",
    async () => {
      const emptyAnalytics = await openScenario("empty");
      const emptyGrid = activityGrid();
      await emptyGrid.waitForDisplayed({ timeout: 15000 });
      expect(await emptyAnalytics.getText()).toContain(
        "No recent dictations have usable audio duration yet.",
      );
      expect(await emptyAnalytics.getText()).not.toContain("0 WPM");
      expect(await emptyAnalytics.getText()).toContain(
        "No saved-word activity is represented for this period.",
      );
      expect(await browser.$('[role="alert"]').isExisting()).toBe(false);

      const failedAnalytics = await openScenario("activity-error");
      const failure = await browser.$('[role="alert"]');
      await failure.waitForDisplayed({ timeout: 15000 });
      expect(await failure.getText()).toContain(
        "We couldn't load saved-word activity.",
      );
      expect(await failedAnalytics.getText()).toContain("73 WPM");
      expect(await activityGrid().isExisting()).toBe(false);
    },
  );

  previewOnly(
    "retains recent-row actions and avoids horizontal overflow at both target sizes",
    async () => {
      await openScenario("populated");
      const copyActions = await browser.$$(
        'button[aria-label="Copy transcript"]',
      );
      expect(copyActions.length).toBeGreaterThanOrEqual(2);
      expect(
        await browser
          .$('button[aria-label="View transcription details"]')
          .isExisting(),
      ).toBe(true);

      for (const viewport of [
        { width: 1100, height: 700 },
        { width: 800, height: 600 },
      ]) {
        await browser.setWindowSize(viewport.width, viewport.height);
        await browser.pause(100);
        const metrics = await viewportMetrics();
        expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.width);
        expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.width);
        expect(metrics.contentRight).toBeLessThanOrEqual(metrics.width + 1);
      }

      const viewAll = await browser.$(
        '//*[contains(@class, "MuiChip-root") and @role="button" and contains(., "View all")]',
      );
      await viewAll.click();
      expect(await browser.getUrl()).toContain("/dashboard/transcriptions");
    },
  );

  previewOnly(
    "shows one calm loading region before delayed activity becomes available",
    async () => {
      await openScenario("activity-loading");
      const status = await browser.$('[role="status"]');
      await status.waitForDisplayed({ timeout: 15000 });
      expect(await status.getText()).toContain("Loading activity history");

      const grid = activityGrid();
      await grid.waitForDisplayed({ timeout: 5000 });
      expect(await status.isExisting()).toBe(false);
    },
  );
});
