/**
 * Capture the figures in `figures.mjs` from the running desktop app.
 *
 * Usage:
 *   node apps/docs/scripts/capture-app.mjs [--only <id>] [--no-seed]
 *
 * Requires a WebDriver endpoint. Start it first:
 *   tauri-driver --port 4444 --native-driver "$(command -v WebKitWebDriver)"
 * and have the renderer reachable at APP_URL (the debug build loads the vite
 * dev server, `pnpm --filter desktop dev:vite`).
 *
 * Every screenshot is the app's own window, in the app's own dark theme. The
 * marker badges are painted into the page and removed after each shot, so they
 * land on the element the annotation list names instead of a guessed pixel.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { APP_FIGURES } from "./figures.mjs";
import { clearMarkers, drawMarkers } from "./lib/markers.mjs";
import { captureRegion, openSession, poll, sleep as sleepFor } from "./lib/webdriver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, "..", "public", "guides");
const driverUrl = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const appUrl = process.env.APP_URL ?? "http://localhost:1420";
const appBinary =
  process.env.TAURI_APP_BINARY ??
  resolve(
    here,
    "..",
    "..",
    "desktop",
    "src-tauri",
    "target",
    "debug",
    "mausVoice",
  );

const run = promisify(execFile);

const readOptions = (argv) => ({
  only: argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null,
});

const waitForDriver = () =>
  poll(async () => {
    try {
      const response = await fetch(`${driverUrl}/status`);
      return (await response.json()).value.ready;
    } catch {
      return false;
    }
  }, `no WebDriver endpoint at ${driverUrl}`);

/**
 * Wait until every marker selector resolves inside the root. A figure whose
 * content is loaded after first paint would otherwise draw its badges before
 * the element they point at exists.
 */
const waitForMarkers = async (session, id, recipe) => {
  const selectors = (recipe.markers ?? []).map((marker) => marker.selector);
  if (selectors.length === 0) return;
  const missing = () =>
    session.execute(`return (() => {
      const root = document.querySelector(${JSON.stringify(recipe.root)});
      if (!root) return [${JSON.stringify(recipe.root)}];
      return ${JSON.stringify(selectors)}.filter((selector) => root.querySelector(selector) === null);
    })()`);
  await poll(async () => (await missing()).length === 0, `${id}: markers never resolved`);
};

/**
 * Close the onboarding tip cards the app floats over a page. They are part of
 * the product, but a card covering the panel a figure documents is not. The
 * cards mount after the page paints, so the click repeats until none is left.
 */
const dismissTips = async (session) => {
  const remaining = () =>
    session.execute(
      `return document.querySelectorAll('[data-tip-card]').length`,
    );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await remaining()) === 0) return;
    await session.execute(
      `document.querySelectorAll('[data-tip-card] button[aria-label]').forEach((button) => button.click())`,
    );
    await sleepFor(300); // NOSONAR javascript:S9382 dismissal is ordered per card
  }
};

const captureFigure = async (session, id, recipe, loaded) => {
  if (recipe.route !== loaded.route) {
    await session.navigate(`${appUrl}${recipe.route}`);
    loaded.route = recipe.route;
  }
  if (recipe.prepare) await session.execute(recipe.prepare);
  await poll(
    () => session.box(recipe.root ?? "main"),
    `${id}: ${recipe.root ?? "main"} never rendered`,
  );
  if (recipe.scroll || recipe.scrollText) {
    const lookup = recipe.scrollText
      ? `[...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")].find((node) => node.textContent.trim().startsWith(${JSON.stringify(recipe.scrollText)}))`
      : `document.querySelector(${JSON.stringify(recipe.scroll)})`;
    await session.execute(`(() => {
      const target = ${lookup};
      if (!target) throw new Error("scroll target missing");
      target.scrollIntoView({ block: "start" });
      return true;
    })()`);
    await sleepFor(500);
  }
  if (recipe.waitText) {
    await poll(
      () => session.execute(`return document.body.innerText.includes(${JSON.stringify(recipe.waitText)})`),
      `${id}: page never showed ${recipe.waitText}`,
    );
  }
  await dismissTips(session);
  await waitForMarkers(session, id, recipe);
  const box = recipe.rect ?? (await session.box(recipe.root));
  if (recipe.markers) await drawMarkers(session, recipe.root, recipe.markers);
  try {
    const png = await captureRegion(session, box, {
      padding: recipe.padding ?? 0,
      scale: recipe.scale ?? 2,
    });
    const file = join(outputDir, `${id}.png`);
    await writeFile(file, png);
    return file;
  } finally {
    await clearMarkers(session);
  }
};

const { only } = readOptions(process.argv.slice(2));
await mkdir(outputDir, { recursive: true });
await waitForDriver();
const session = await openSession(driverUrl, appBinary);
const loaded = { route: null };
const files = [];
try {
  for (const [id, recipe] of Object.entries(APP_FIGURES)) {
    if (only && id !== only) continue;
    files.push(await captureFigure(session, id, recipe, loaded)); // NOSONAR javascript:S9382 one window, captures must serialise
  }
} finally {
  await session.close();
}
console.log(`captured ${files.length} images`);
for (const file of files) console.log(`  ${file}`);
