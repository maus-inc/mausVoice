#!/usr/bin/env node
/**
 * ui-capture: record a browser storyboard into a frame sequence for a smooth GIF.
 *
 *   node capture.mjs <storyboard.json> [--out DIR] [--fps 30] [--capture-fps 60]
 *   node capture.mjs --example            # print the storyboard schema and exit
 *
 * The storyboard is JSON (see ../references/storyboard.md). capture.mjs launches
 * Chromium through the same resolution order as the repo's playwright.config.ts,
 * installs scripts/overlay.js before the first paint, then runs the storyboard
 * while a capture loop writes viewport JPEGs to <out>/frames/. A paced screenshot
 * loop reaches ~60fps on a headless host, so the GIF can be encoded at a true
 * 30fps from real frames rather than resampled duplicates.
 *
 * Outputs under <out>/:
 *   frames/f000001.jpg ...   captured frames, in order
 *   screenshots/<label>.png  one still per `screenshot` step (static evidence)
 *   timeline.json            per-step frame ranges, subtitles and scene markers
 *
 * Exit code is non-zero on any failed step, so a wrapper can stop before encoding.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY = join(HERE, "overlay.js");

const log = (line = "") => process.stdout.write(`${line}\n`);

/* ------------------------------------------------------------------ *
 * Browser resolution: mirror playwright.config.ts so the same sandbox
 * rules apply (explicit override, bundled, @sparticuz, vendored tree).
 * ------------------------------------------------------------------ */

const sandboxLibsEnv = () => {
  const env = { ...process.env };
  const libs = process.env.PLAYWRIGHT_SANDBOX_LIBS;
  if (libs) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libs}:${env.LD_LIBRARY_PATH}` : libs;
  }
  return env;
};

const bundledUsable = () => {
  try {
    const { chromium } = require("playwright-core");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return false;
    execFileSync(exe, ["--version"], { stdio: "ignore", timeout: 60_000, env: sandboxLibsEnv() });
    return true;
  } catch {
    return false;
  }
};

const sparticuzPath = () => {
  try {
    const mod = require("@sparticuz/chromium");
    const resolved = execFileSync(
      process.execPath,
      ["-e", "require('@sparticuz/chromium').default.executablePath().then((p)=>process.stdout.write(p))"],
      { encoding: "utf8" },
    ).trim();
    return resolved || "";
  } catch {
    return "";
  }
};

const SANDBOX_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"];

const resolveChromium = () => {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: SANDBOX_ARGS };
  }
  if (bundledUsable()) return { args: SANDBOX_ARGS };
  const sp = sparticuzPath();
  if (sp && existsSync(sp)) return { executablePath: sp, args: SANDBOX_ARGS };
  for (const guess of ["/tmp/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(guess)) return { executablePath: guess, args: SANDBOX_ARGS };
  }
  throw new Error(
    "No Chromium found. Set PLAYWRIGHT_CHROMIUM_PATH, run `npx playwright install chromium`, " +
      "or install @sparticuz/chromium. See AGENTS.md, Blocked sandbox toolchain.",
  );
};

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

const EXAMPLE_PATH = join(HERE, "..", "examples", "example-storyboard.json");
const EXAMPLE = existsSync(EXAMPLE_PATH)
  ? readFileSync(EXAMPLE_PATH, "utf8")
  : '{\n  "name": "capture",\n  "url": "http://127.0.0.1:48921/",\n  "steps": []\n}';

const argv = process.argv.slice(2);
if (argv.includes("--example")) {
  log(EXAMPLE);
  process.exit(0);
}

const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const storyboardPath = argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!storyboardPath) {
  log("usage: node capture.mjs <storyboard.json> [--out DIR] [--fps 30] [--capture-fps 60]");
  log("       node capture.mjs --example");
  process.exit(2);
}

const board = JSON.parse(readFileSync(resolve(storyboardPath), "utf8"));
const outDir = resolve(opt("--out", board.outDir ?? ".qa-artifacts/capture"));
const targetFps = Number(opt("--fps", board.fps ?? 30));
const captureFps = Number(opt("--capture-fps", board.captureFps ?? 60));
const viewport = board.viewport ?? { width: 1280, height: 800 };
const scale = board.deviceScaleFactor ?? 1;

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

const framesDir = join(outDir, "frames");
const shotsDir = join(outDir, "screenshots");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const { chromium } = require("playwright-core");

const main = async () => {
  const launch = resolveChromium();
  const browser = await chromium.launch({
    executablePath: launch.executablePath,
    args: launch.args,
    env: sandboxLibsEnv(),
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    // A stable clock and no prefers-reduced-motion surprises: the capture must
    // show the animation the code actually ships, not an accessibility override.
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript({ path: OVERLAY });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = board.url ?? "http://127.0.0.1:48921/";
  log(`[capture] ${board.name ?? "storyboard"} -> ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(board.settleMs ?? 600);

  const framePath = (i) => join(framesDir, `f${String(i).padStart(6, "0")}.jpg`);
  const frameInterval = 1000 / captureFps;
  const started = Date.now();
  let frameIndex = 0;
  let stopped = false;

  // The capture loop runs concurrently with the storyboard so frames land
  // during mouse moves and CSS transitions, not only between steps. The
  // `busy` flag serialises screenshot calls: Playwright queues them, and
  // overlapping calls would drift the cadence.
  const captureLoop = (async () => {
    let busy = false;
    while (!stopped) {
      const tick = Date.now();
      if (!busy) {
        busy = true;
        try {
          const buf = await page.screenshot({ type: "jpeg", quality: board.quality ?? 90 });
          writeFileSync(framePath(frameIndex), buf);
          frameIndex++;
        } catch {
          // A screenshot can fail if the page is mid-navigation; the next
          // tick retries. A persistent failure shows up as a short timeline.
        } finally {
          busy = false;
        }
      }
      const elapsed = Date.now() - tick;
      const wait = Math.max(0, frameInterval - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();

  const stepToPoint = async (step) => {
    if (step.selector) {
      const el = page.locator(step.selector).first();
      await el.waitFor({ state: "visible", timeout: 15_000 });
      const box = await el.boundingBox();
      if (!box) throw new Error(`selector not visible: ${step.selector}`);
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    }
    return { x: Math.round(step.x ?? 0), y: Math.round(step.y ?? 0) };
  };

  // Move the real pointer and the overlay cursor together, one interpolation
  // step at a time, so a hover state fires exactly when the cursor visually
  // reaches the element. A CSS-transition cursor with an instant real pointer
  // desyncs the two: hover styling would appear before the cursor arrives.
  const glide = async (to, ms, steps = 0) => {
    const from = await page.evaluate(() => window.__uicap?.point ?? { x: 0, y: 0 });
    const n = steps || Math.max(1, Math.round((ms || 0) / (1000 / captureFps)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      await page.evaluate(([x, y]) => window.__uicap?.move(x, y, 0), [x, y]);
      await page.mouse.move(x, y);
      if (ms) await page.waitForTimeout(ms / n);
    }
  };

  const timeline = [];
  const record = (step, startFrame) => {
    timeline.push({ ...step, startFrame, endFrame: frameIndex });
  };

  for (const step of board.steps ?? []) {
    const startFrame = frameIndex;
    const action = step.action ?? "wait";
    switch (action) {
      case "subtitle":
        await page.evaluate((t) => window.__uicap?.setSubtitle(t), step.text ?? "");
        break;
      case "badge":
        await page.evaluate((t) => window.__uicap?.setBadge(t), step.text ?? "");
        break;
      case "move": {
        const p = await stepToPoint(step);
        const ms = step.ms ?? 500;
        await glide(p, ms, step.steps ?? 0);
        break;
      }
      case "click": {
        const p = await stepToPoint(step);
        await glide(p, step.ms ?? 450, step.steps ?? 0);
        await page.evaluate(() => window.__uicap?.down());
        await page.waitForTimeout(step.holdMs ?? 90);
        await page.mouse.down();
        await page.mouse.up();
        await page.evaluate(() => window.__uicap?.up());
        if (step.button === "right") await page.mouse.click(p.x, p.y, { button: "right" });
        break;
      }
      case "dblclick": {
        const p = await stepToPoint(step);
        await glide(p, step.ms ?? 450, step.steps ?? 0);
        await page.evaluate(() => window.__uicap?.down());
        await page.mouse.dblclick(p.x, p.y);
        await page.evaluate(() => window.__uicap?.up());
        break;
      }
      case "hover": {
        const p = await stepToPoint(step);
        await glide(p, step.ms ?? 400, step.steps ?? 0);
        break;
      }
      case "drag": {
        const from = await stepToPoint(step.from ?? step);
        const to = await stepToPoint(step.to ?? step);
        await glide(from, step.ms ?? 300);
        await page.evaluate(() => window.__uicap?.down());
        await page.mouse.down();
        await glide(to, step.ms ?? 400, step.steps ?? 30);
        await page.mouse.up();
        await page.evaluate(() => window.__uicap?.up());
        break;
      }
      case "type": {
        if (step.selector) {
          const p = await stepToPoint(step);
          await glide(p, step.ms ?? 400, step.steps ?? 0);
          await page.locator(step.selector).first().click();
        }
        await page.keyboard.type(step.text ?? "", { delay: step.delay ?? 45 });
        break;
      }
      case "press":
        await page.keyboard.press(step.key);
        break;
      case "scroll": {
        const p = await page.evaluate(() => window.__uicap?.point ?? { x: viewport.width / 2, y: viewport.height / 2 });
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(step.dx ?? 0, step.dy ?? 400);
        break;
      }
      case "screenshot": {
        const label = (step.label ?? `shot-${timeline.length + 1}`).replace(/[^\w.-]+/g, "_");
        await page.screenshot({ path: join(shotsDir, `${label}.png`), fullPage: Boolean(step.fullPage) });
        break;
      }
      case "scene":
        // A scene marker only labels a segment for GIF splitting; no page action.
        break;
      case "wait":
      default:
        await page.waitForTimeout(step.ms ?? 400);
        break;
    }
    if (step.waitMs) await page.waitForTimeout(step.waitMs);
    record({ action, ...step }, startFrame);
  }

  await page.waitForTimeout(board.tailMs ?? 600);
  stopped = true;
  await captureLoop;
  const durationMs = Date.now() - started;

  const gifFrames = Math.max(1, Math.round((durationMs / 1000) * targetFps));
  const manifest = {
    name: board.name ?? "capture",
    url,
    viewport,
    capturedFrames: frameIndex,
    captureFps: Number((frameIndex / (durationMs / 1000)).toFixed(1)),
    durationMs,
    gifFps: targetFps,
    gifFrames,
    timeline,
    errors,
  };
  writeFileSync(join(outDir, "timeline.json"), JSON.stringify(manifest, null, 2));

  await context.close();
  await browser.close();

  log(`[capture] ${frameIndex} frames in ${(durationMs / 1000).toFixed(2)}s ` +
      `(${manifest.captureFps} fps effective), target ${targetFps} fps -> ${gifFrames} gif frames`);
  if (errors.length) {
    // Console errors from a React dev build can be thousands of characters of
    // component source. Keep one line each so the terminal stays readable; the
    // full text stays in the capture report.
    log(`[capture] ${errors.length} console/page error(s):`);
    for (const e of errors.slice(0, 5)) log(`  ! ${String(e).split("\n")[0].slice(0, 200)}`);
  }
  log(`[capture] wrote ${outDir}`);
};

main().catch((err) => {
  log(`[capture] FAILED: ${err.message}`);
  process.exit(1);
});
