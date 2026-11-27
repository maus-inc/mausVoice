// Captures settings geometry at supported window sizes and checks headings, assets, and overflow.
import { writeFileSync } from "node:fs";
import { createReportDirectory } from "./browser-config.mjs";
import { launch, newPage, sleep, waitForTruthy } from "./cdp.mjs";
import { watchPage } from "./page-watch.mjs";

const OUT = createReportDirectory();
const EXPECTED_HEADING_ALIGNMENT =
  process.env.EXPECTED_HEADING_ALIGNMENT || "card-edge";
const THEME = process.env.THEME || "light";

const HARNESS_BASE =
  process.env.HARNESS_URL ||
  "http://127.0.0.1:5193/verify-harness/settings.html";

/** The window sizes `src-tauri/tauri.conf.json` allows, plus a wide one. */
const SIZES = [
  { width: 1280, height: 900 },
  { width: 1100, height: 700 },
  { width: 800, height: 600 },
];

/** Route ids, in rail order. */
const PAGES = [
  "home",
  "dictation",
  "ai-models",
  "shortcuts",
  "appearance",
  "privacy-data",
  "system",
  "account",
];

const problems = [];
const note = (label, detail) => problems.push(`${label}: ${detail}`);

/** A measured value, or `null` when the page drew nothing to measure. */
const orNull = (value) => (value === undefined ? null : value);

/** Reports group dimensions and heading alignment against the card edge. */
const reportedGroup = ({ title, rows, card, columns }) => {
  const head = title ?? {};
  const frame = card ?? {};
  return {
    title: orNull(head.text),
    rows,
    top: orNull(frame.y),
    height: orNull(frame.h),
    labelX: orNull(columns[0]),
    cardX: orNull(frame.x),
    headingX: orNull(head.x),
  };
};

const measure = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
  };
  const heading = document.querySelector("h1");
  const columnOf = (element) => {
    const label = element.querySelector(".setting-row-label");
    return label ? box(label).x : null;
  };
  return {
    heading: heading ? { text: heading.textContent, ...box(heading) } : null,
    groups: Array.from(document.querySelectorAll("section")).map((section) => {
      const title = section.querySelector("h2");
      const card = section.lastElementChild;
      // Every row of a card, by the label class rather than by position: the
      // row that starts a card is not the one that names the column.
      const columns = card
        ? Array.from(card.children)
            .map(columnOf)
            .filter((x) => x !== null)
        : [];
      return {
        title: title ? { text: title.textContent, ...box(title) } : null,
        card: card ? box(card) : null,
        rows: card ? card.children.length : 0,
        columns,
      };
    }),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

const { port, cleanup } = await launch({
  width: SIZES[0].width,
  height: SIZES[0].height,
});
const page = await newPage(port);

const { consoleErrors, failedRequests } = watchPage(page);
await page.send("Network.enable");

const report = {
  theme: THEME,
  expectedHeadingAlignment: EXPECTED_HEADING_ALIGNMENT,
  sizes: [],
  consoleErrors,
  failedRequests,
  problems,
};

for (const { width, height } of SIZES) {
  await page.setViewport(width, height);

  for (const id of PAGES) {
    await page.goto(`${HARNESS_BASE}?page=${id}&theme=${THEME}`);
    const readiness = await waitForTruthy({
      evaluate: (expression) => page.evaluate(expression),
      expression: "Boolean(document.querySelector('h1'))",
      timeoutMs: 30_000,
    });
    if (!readiness.ok) {
      note(`${width}px ${id} readiness`, "no h1 within 30 s");
      continue;
    }
    // The page chunks mount after the shell, so the measured frame is the one
    // after the rows exist rather than the one with the loading state in it.
    await sleep(1200);
    await page.evaluate("document.fonts.ready.then(() => true)");

    const assetReadiness = await page.evaluate(`(() => {
      const faces = Array.from(document.fonts).map((face) => ({
        family: face.family.replace(/[\"']/g, ""),
        status: face.status,
      }));
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        satoshiLoaded: faces.some((face) => face.family === "Satoshi" && face.status === "loaded"),
        uiFont: body.fontFamily,
        spacing: root.getPropertyValue("--app-spacing").trim() || body.getPropertyValue("--app-spacing").trim(),
      };
    })()`);
    if (
      !assetReadiness.satoshiLoaded ||
      !assetReadiness.uiFont.includes("Satoshi")
    ) {
      note(`${width}px ${id} font`, JSON.stringify(assetReadiness));
    }
    if (!assetReadiness.spacing) {
      note(`${width}px ${id} spacing`, "--app-spacing is not defined");
    }

    const metrics = await page.evaluate(measure);
    writeFileSync(
      `${OUT}/settings-${width}-${id}.png`,
      await page.screenshot(),
    );

    const labelXs = [
      ...new Set(metrics.groups.flatMap((group) => group.columns)),
    ];
    const groupXs = [
      ...new Set(metrics.groups.map((group) => group.title?.x ?? null)),
    ].filter((x) => x !== null);

    // The check is per card, not per page: the overview sets two cards side by
    // side, and each heading names its own card from that card's outer edge.
    for (const group of metrics.groups) {
      const columns = [...new Set(group.columns)];
      const name = group.title?.text ?? "untitled";
      if (columns.length > 1) {
        note(
          `${width}px ${id} "${name}" label column`,
          `rows start at ${columns.join(", ")}`,
        );
      }
      if (EXPECTED_HEADING_ALIGNMENT === "card-edge") {
        if (group.title && group.card && group.title.x !== group.card.x) {
          note(
            `${width}px ${id} "${name}" heading edge`,
            `heading at ${group.title.x}, card at ${group.card.x}`,
          );
        }
      } else if (
        EXPECTED_HEADING_ALIGNMENT === "row-label" &&
        group.title &&
        columns.length === 1 &&
        group.title.x !== columns[0]
      ) {
        note(
          `${width}px ${id} "${name}" heading column`,
          `heading at ${group.title.x}, rows at ${columns[0]}`,
        );
      }
    }
    for (const group of metrics.groups) {
      if (group.rows === 0) {
        note(`${width}px ${id} empty group`, group.title?.text ?? "untitled");
      }
    }
    if (metrics.overflowX > 0) {
      note(
        `${width}px ${id} overflow`,
        `${metrics.overflowX}px wider than the window`,
      );
    }
    if (
      metrics.heading &&
      (metrics.heading.y < 0 || metrics.heading.y + metrics.heading.h > height)
    ) {
      note(`${width}px ${id} clipping`, `heading at y=${metrics.heading.y}`);
    }

    // Derived columns rather than every label: the report is read as a diff,
    // and one line per page says what the layout did without listing the twenty
    // rows that produced it. A group keeps its height and its top edge, which is
    // how the vertical rhythm between groups shows up in a diff.
    report.sizes.push({
      width,
      height,
      page: id,
      heading: metrics.heading,
      labelColumns: labelXs,
      headingColumns: groupXs,
      groups: metrics.groups.map(reportedGroup),
      overflowX: metrics.overflowX,
    });
    console.log(
      width,
      id,
      JSON.stringify(metrics.heading),
      "labels",
      JSON.stringify(labelXs),
      "groups",
      metrics.groups.length,
    );
  }
}

// Pages are compared within a width: the same line, so a short page cannot
// centre itself while a long one starts at the top.
for (const { width } of SIZES) {
  const onWidth = report.sizes.filter((entry) => entry.width === width);
  const headingXs = [...new Set(onWidth.map((entry) => entry.heading?.x))];
  const headingYs = [...new Set(onWidth.map((entry) => entry.heading?.y))];
  if (headingXs.length > 1) {
    note(`${width}px page column`, `headings start at ${headingXs.join(", ")}`);
  }
  if (headingYs.length > 1) {
    note(`${width}px page line`, `headings start at ${headingYs.join(", ")}`);
  }
}

writeFileSync(`${OUT}/settings-layout.json`, JSON.stringify(report, null, 2));
console.log("wrote", `${OUT}/settings-layout.json`);
console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors.slice(0, 10)));
console.log("PROBLEMS:", JSON.stringify(problems, null, 2));

// A probe that only prints its findings cannot fail a run. The other probes in
// this directory set the exit code for the same reason.
if (problems.length > 0 || consoleErrors.length > 0) {
  process.exitCode = 1;
}

page.close();
cleanup();
