// Captures Help page geometry, sibling alignment, WCAG contrast, overflow,
// and live TipCard rendering across supported window sizes and themes.
import { writeFileSync } from "node:fs";
import { createReportDirectory } from "./browser-config.mjs";
import { launch, newPage, sleep, waitForTruthy } from "./cdp.mjs";
import { watchPage } from "./page-watch.mjs";

const OUT = createReportDirectory();
const THEME = process.env.THEME || "light";
const PREFIX = process.env.SHOT_PREFIX || "help";
const HARNESS_BASE =
  process.env.HARNESS_URL || "http://127.0.0.1:5193/verify-harness/help.html";

const SIZES = [
  { width: 1280, height: 900, compareSibling: true },
  { width: 1100, height: 700, compareSibling: false },
  { width: 800, height: 600, compareSibling: true },
  { width: 560, height: 700, compareSibling: false },
];

const parseRgba = (cssColor) => {
  const match = cssColor?.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
  );
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const composite = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

const relativeLuminance = ({ r, g, b }) => {
  const linear = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrastRatio = (fgCss, bgCss, canvasCss) => {
  const colors = [canvasCss, bgCss, fgCss].map(parseRgba);
  if (colors.some((color) => color === null)) return 0;
  const [canvas, bgRaw, fgRaw] = colors;
  const surface = composite(bgRaw, canvas);
  const text = composite(fgRaw, surface);
  const l1 = relativeLuminance(text);
  const l2 = relativeLuminance(surface);
  return (
    Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) /
    100
  );
};

const MEASURE_EXPR = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), right: round(r.right), bottom: round(r.bottom), w: round(r.width), h: round(r.height) };
  };
  const h1 = document.querySelector("h1");
  const main = document.querySelector("main");
  const canvas = main?.parentElement?.parentElement;
  const subtitle = h1?.parentElement?.querySelector(".MuiTypography-subtitle1");
  const cards = Array.from(document.querySelectorAll('[data-tip-frame="true"]')).map((card) => {
    const title = card.querySelector('[data-tip-title="true"]');
    const body = card.querySelector(".MuiTypography-body2");
    const icon = card.querySelector("svg");
    const buttons = Array.from(card.querySelectorAll("button")).map((btn) => ({
      text: btn.textContent?.trim() ?? "",
      ...rectOf(btn),
    }));
    const cs = getComputedStyle(card);
    return {
      titleText: title?.textContent?.trim() ?? "",
      card: rectOf(card),
      title: rectOf(title),
      body: rectOf(body),
      icon: rectOf(icon),
      buttons,
      opacity: cs.opacity,
      bg: cs.backgroundColor,
      borderColor: cs.borderTopColor,
      borderStyle: cs.borderTopStyle,
      titleColor: title ? getComputedStyle(title).color : null,
      bodyColor: body ? getComputedStyle(body).color : null,
    };
  });
  return {
    canvasBg: getComputedStyle(canvas ?? document.body).backgroundColor,
    main: rectOf(main),
    h1: h1 ? { text: h1.textContent?.trim(), fontSize: getComputedStyle(h1).fontSize, fontWeight: getComputedStyle(h1).fontWeight, ...rectOf(h1) } : null,
    subtitle: subtitle ? { color: getComputedStyle(subtitle).color, ...rectOf(subtitle) } : null,
    cards,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    mainOverflowX: main ? main.scrollWidth - main.clientWidth : 0,
  };
})()`;

const uniqueValues = (list) => [...new Set(list)];

const checkCondition = (ok, label, detail, note) => {
  if (!ok) note(label, detail);
};

const checkFontAndTokens = async (page, label, note) => {
  const state = await page.evaluate(`(() => {
    const faces = Array.from(document.fonts).map((f) => ({
      family: f.family.replace(/["']/g, ""),
      status: f.status,
    }));
    return {
      satoshi: faces.some((f) => f.family === "Satoshi" && f.status === "loaded"),
      spacing: getComputedStyle(document.documentElement).getPropertyValue("--app-spacing").trim(),
    };
  })()`);
  checkCondition(
    state.satoshi,
    `${label} font`,
    "Satoshi webfont not loaded",
    note,
  );
  checkCondition(
    Boolean(state.spacing),
    `${label} spacing`,
    "--app-spacing not defined",
    note,
  );
};

const checkOverflowAndHeading = (metrics, label, note) => {
  const overflowOk = Math.max(metrics.overflowX, metrics.mainOverflowX) <= 0;
  checkCondition(
    overflowOk,
    `${label} overflow`,
    `doc=${metrics.overflowX} main=${metrics.mainOverflowX}`,
    note,
  );
  const h1 = metrics.h1 ?? {};
  const headingOk = h1.fontSize === "34px" && h1.fontWeight === "700";
  checkCondition(
    headingOk,
    `${label} h1 scale`,
    JSON.stringify(metrics.h1),
    note,
  );
};

const checkCardRails = (metrics, label, note) => {
  const widths = uniqueValues(metrics.cards.map((c) => c.card?.w));
  const cardXs = uniqueValues(metrics.cards.map((c) => c.card?.x));
  const railXs = uniqueValues(
    metrics.cards.flatMap((c) => [c.title?.x, c.body?.x, c.buttons[0]?.x]),
  );
  checkCondition(
    widths.length === 1,
    `${label} card width`,
    widths.join(","),
    note,
  );
  checkCondition(
    cardXs.length === 1 && cardXs[0] === metrics.h1?.x,
    `${label} card edge`,
    `h1=${metrics.h1?.x} cards=${cardXs.join(",")}`,
    note,
  );
  checkCondition(
    railXs.length === 1,
    `${label} inner rail`,
    railXs.join(","),
    note,
  );
  return { cardW: widths[0], railX: railXs[0] };
};

const iconTitleDelta = (card) => {
  if (!card.icon || !card.title) return 0;
  return Math.abs(card.icon.y + card.icon.h / 2 - (card.title.y + 10.125));
};

const checkSingleCard = (card, canvasBg, label, note) => {
  const titleRatio = contrastRatio(card.titleColor, card.bg, canvasBg);
  const bodyRatio = contrastRatio(card.bodyColor, card.bg, canvasBg);
  card.titleContrast = titleRatio;
  card.bodyContrast = bodyRatio;
  const minRatio = Math.min(titleRatio, bodyRatio);
  checkCondition(
    minRatio >= 4.5,
    `${label} "${card.titleText}" contrast`,
    `title=${titleRatio} body=${bodyRatio}`,
    note,
  );
  checkCondition(
    card.opacity === "1",
    `${label} "${card.titleText}" opacity`,
    card.opacity,
    note,
  );
  const delta = iconTitleDelta(card);
  checkCondition(
    delta <= 2,
    `${label} "${card.titleText}" icon align`,
    `delta=${delta.toFixed(1)}px`,
    note,
  );
  return minRatio;
};

const checkCardVisuals = (metrics, label, note) => {
  const subRatio = contrastRatio(
    metrics.subtitle?.color,
    metrics.canvasBg,
    metrics.canvasBg,
  );
  checkCondition(
    subRatio >= 4.5,
    `${label} subtitle contrast`,
    `ratio=${subRatio}`,
    note,
  );

  const cardMins = metrics.cards.map((card) =>
    checkSingleCard(card, metrics.canvasBg, label, note),
  );
  const dashedCount = metrics.cards.filter(
    (c) => c.borderStyle === "dashed",
  ).length;
  checkCondition(
    dashedCount === 2,
    `${label} dismissed count`,
    `dashed=${dashedCount}`,
    note,
  );
  return { subRatio, minContrast: Math.min(...cardMins) };
};

const captureSibling = async (page, size, helpH1Y, report, note) => {
  const { width, height } = size;
  await page.goto(`${HARNESS_BASE}?view=dictionary&theme=${THEME}`);
  await waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression: "Boolean(document.querySelector('h1'))",
    timeoutMs: 30_000,
  });
  await sleep(400);
  await page.evaluate("document.fonts.ready.then(() => true)");
  const dictMetrics = await page.evaluate(MEASURE_EXPR);
  writeFileSync(
    `${OUT}/${PREFIX}-sibling-dict-${THEME}-${width}x${height}.png`,
    await page.screenshot(),
  );
  checkCondition(
    dictMetrics.h1?.y === helpH1Y,
    `${width}x${height} sibling h1.y`,
    `help=${helpH1Y} dict=${dictMetrics.h1?.y}`,
    note,
  );
  report.captures.push({
    view: "dictionary",
    width,
    height,
    metrics: dictMetrics,
  });
};

const captureLiveTip = async (page, note) => {
  await page.setViewport(1100, 700);
  await page.goto(`${HARNESS_BASE}?view=live-tip&theme=${THEME}`);
  const ready = await waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression:
      "document.querySelectorAll('[data-tip-card=\"true\"]').length === 2",
    timeoutMs: 30_000,
  });
  if (!ready.ok) {
    note("live-tip", "live TipCards did not mount");
    return;
  }
  await sleep(400);
  await page.evaluate("document.fonts.ready.then(() => true)");
  writeFileSync(
    `${OUT}/${PREFIX}-live-tip-${THEME}.png`,
    await page.screenshot(),
  );
};

const captureHelpViewport = async (page, size, report, note) => {
  const { width, height, compareSibling } = size;
  const label = `${width}x${height}`;
  await page.setViewport(width, height);
  await page.goto(`${HARNESS_BASE}?view=help&theme=${THEME}`);
  const mounted = await waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression:
      "document.querySelectorAll('[data-tip-frame=\"true\"]').length === 5",
    timeoutMs: 30_000,
  });
  if (!mounted.ok) {
    note(label, "HelpPage did not mount 5 tip cards");
    return;
  }
  await sleep(400);
  await page.evaluate("document.fonts.ready.then(() => true)");
  await checkFontAndTokens(page, label, note);

  const metrics = await page.evaluate(MEASURE_EXPR);
  writeFileSync(
    `${OUT}/${PREFIX}-${THEME}-${label}.png`,
    await page.screenshot(),
  );
  checkOverflowAndHeading(metrics, label, note);
  const { cardW, railX } = checkCardRails(metrics, label, note);
  const { subRatio, minContrast } = checkCardVisuals(metrics, label, note);

  report.captures.push({
    view: "help",
    width,
    height,
    subtitleContrast: subRatio,
    metrics,
  });
  const h1 = metrics.h1 ?? {};
  console.log(
    `help ${THEME} ${label} h1=(${h1.x},${h1.y}) cardW=${cardW} railX=${railX} minContrast=${minContrast} overflow=${metrics.overflowX}/${metrics.mainOverflowX}`,
  );

  if (compareSibling) {
    await captureSibling(page, size, h1.y, report, note);
  }
};

const runSweep = async () => {
  const problems = [];
  const note = (label, detail) => problems.push(`${label}: ${detail}`);
  const browser = await launch({ width: 1280, height: 900 });
  const page = await newPage(browser.port);
  const { consoleErrors, failedRequests } = watchPage(page);
  await page.send("Network.enable");

  const report = {
    theme: THEME,
    prefix: PREFIX,
    captures: [],
    problems,
    consoleErrors,
    failedRequests,
  };

  for (const size of SIZES) {
    await captureHelpViewport(page, size, report, note);
  }
  await captureLiveTip(page, note);

  const reportPath = `${OUT}/${PREFIX}-${THEME}-report.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log("REPORT:", reportPath);
  console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors));
  console.log("FAILED_REQUESTS:", JSON.stringify(failedRequests));
  console.log("PROBLEMS:", JSON.stringify(problems, null, 2));

  page.close();
  browser.cleanup();
  return problems.length + consoleErrors.length;
};

if ((await runSweep()) > 0) {
  process.exitCode = 1;
}
