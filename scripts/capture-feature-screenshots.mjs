#!/usr/bin/env node
/*
 * Capture README feature screenshots by rendering a static HTML/CSS mock of
 * the mausVoice desktop UI in headless Chromium (via Playwright) and
 * screenshotting each fixture at exactly 1600x760 PNG.
 *
 * This script is documentation/test-support only. It is reproducible:
 * running it again regenerates identical screenshots from the bundled
 * fixture assets. No third-party imagery, AI-generated imagery, or
 * placeholder art is used. UI text and structure are derived from
 * apps/desktop/src and apps/desktop/src-tauri/.
 *
 * Usage:
 *   node scripts/capture-feature-screenshots.mjs
 *
 * Output:
 *   docs/assets/features/{dictate-anywhere,choose-your-engine,
 *     writing-styles,dictionary-history,assistant-approval}.png
 *
 * Requirements:
 *   - Node 20+
 *   - `playwright` and `chromium` installed. From the repo root:
 *       node scripts/capture-feature-screenshots.mjs
 *     The first run will download chromium into the local playwright cache.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "docs/assets/features/fixture");
const outputDir = path.join(repoRoot, "docs/assets/features");

const FIXTURES = [
  "dictate-anywhere",
  "choose-your-engine",
  "writing-styles",
  "dictionary-history",
  "assistant-approval",
];

const VIEWPORT = { width: 1600, height: 760 };

async function main() {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  let chromium;
  try {
    const mod = await import("playwright");
    chromium = mod.chromium;
  } catch {
    console.error("playwright is not installed. Run: npm install playwright && npx playwright install chromium");
    process.exit(1);
  }

  const launchArgs = { headless: true };
  if (process.env.CI) {
    launchArgs.args = ["--no-sandbox"];
  }
  const browser = await chromium.launch(launchArgs);
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });

  for (const slug of FIXTURES) {
    const htmlPath = path.join(fixtureDir, `${slug}.html`);
    if (!existsSync(htmlPath)) {
      throw new Error(`Missing fixture: ${htmlPath}`);
    }
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: "load",
    });
    await page.waitForTimeout(120);
    const outPath = path.join(outputDir, `${slug}.png`);
    await page.screenshot({
      path: outPath,
      type: "png",
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      },
    });
    await page.close();
    console.log(`captured ${slug} -> ${path.relative(repoRoot, outPath)}`);
  }

  await context.close();
  await browser.close();
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}