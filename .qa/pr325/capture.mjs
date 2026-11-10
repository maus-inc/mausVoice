/**
 * PR #325 capture: the UI surfaces this branch touches, rendered by the real
 * preview app in the vendored Chromium, in both themes.
 *
 * Why this file exists rather than `.agents/skills/ui-capture/scripts/capture.mjs`:
 * that pipeline is Playwright-driven and needs `ffmpeg`/`ffprobe`/`gifsicle` for
 * the encode step, none of which exist in this image (gap G9). What *does* exist
 * is the vendored Chromium at `/tmp/chrome/out/chromium`, and Node 22 ships a
 * `WebSocket` global, so this drives Chrome DevTools Protocol directly. The
 * pixels are the ones the real app paints: the preview app mounts the real
 * `apps/desktop` components against the real theme, so this captures the branch,
 * not a mock.
 *
 * Geometry follows `.qa/pr288`: a fixed 1200px-wide viewport, so a screenshot is
 * the size of an app window and every file is small enough to keep in the tree.
 * Pages taller than the frame are captured at their full height up to
 * `MAX_HEIGHT`, and the size is part of the filename, so a reviewer can see at a
 * glance whether a frame was cropped.
 *
 * Output: `<surface>-<theme>-<WxH>.jpg` in this directory. The PNG masters go to
 * a scratch path outside the repo so the tree only carries the review copy.
 *
 * Usage: node .qa/pr325/capture.mjs   (preview must already be serving :5193)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/tmp/chrome/out/chromium";
const LIBS = process.env.CHROME_LIBS ?? "/tmp/chrome/libs/lib";
const ORIGIN = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:5193";
const OUT = import.meta.dirname;
const SCRATCH = process.env.SCRATCH_DIR ?? "/tmp/pr325-png";
const PORT = 9222;

const WIDTH = 1200;
const MIN_HEIGHT = 800;
const MAX_HEIGHT = 3000;

/** Every surface this branch touched, in the order a reviewer should read them. */
const SHOTS = [
  {
    name: "provider-marks",
    hash: "/#/provider-marks",
    height: "auto",
  },
  {
    // The dialog is a modal: it is centred in the viewport and the page behind
    // it is dimmed, so this surface is captured at the app's own window size
    // rather than at the height of the page it covers.
    name: "personal-api-key-dialog",
    hash: "/#/provider-marks?dialog=deepgram",
    height: MIN_HEIGHT,
  },
  {
    name: "provider-logo-matrix",
    hash: "/#/c/provider-logo",
    height: "auto",
  },
];

const THEMES = ["light", "dark"];

const main = async () => {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  const profile = path.join(SCRATCH, "profile");
  await mkdir(profile, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      env: { ...process.env, LD_LIBRARY_PATH: LIBS },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const cleanup = async () => {
    chrome.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
  };

  let wsUrl = null;
  for (let attempt = 0; attempt < 150 && !wsUrl; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) =>
        r.json(),
      );
      const page = list.find((target) => target.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) {
    await cleanup();
    throw new Error(`Chromium never exposed a page target.\n${stderr}`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression, args = []) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      args: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(
        `evaluate failed: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`,
      );
    }
    return result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  const written = [];

  for (const theme of THEMES) {
    for (const shot of SHOTS) {
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH,
        height: MIN_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await send("Page.navigate", { url: `${ORIGIN}${shot.hash}` });

      // Wait for the React tree to have painted a heading, not merely for the
      // document to load: the preview mounts after its module graph runs.
      await evaluate(
        `new Promise((resolve, reject) => {
          const started = Date.now();
          const tick = () => {
            const heading = document.querySelector("h1, h2");
            if (heading && heading.textContent.trim().length > 0) return resolve(true);
            if (Date.now() - started > 25000) return reject(new Error("no heading painted"));
            requestAnimationFrame(tick);
          };
          tick();
        })`,
      );

      // Set the scheme through the app's own control, the same branch a user
      // takes. The toggle cycles system -> light -> dark.
      for (let hop = 0; hop < 3; hop += 1) {
        const scheme = await evaluate(
          `document.documentElement.dataset.muiColorScheme`,
        );
        if (scheme === theme) break;
        const clicked = await evaluate(
          `(() => {
             const button = document.querySelector('[aria-label="Toggle color scheme"]');
             if (!button) return false;
             button.click();
             return true;
           })()`,
        );
        if (!clicked) {
          throw new Error(`no scheme toggle on ${shot.name}`);
        }
        await sleep(450);
      }

      const settled = await evaluate(
        `document.documentElement.dataset.muiColorScheme`,
      );
      if (settled !== theme) {
        throw new Error(
          `could not settle ${theme} on ${shot.name}; saw ${settled}`,
        );
      }

      // Fonts and the vendored SVGs must be in before the snapshot, otherwise a
      // mark photographs as an empty box.
      await evaluate(`document.fonts.ready.then(() => true)`);
      await sleep(700);

      /**
       * The preview is an app shell with a fixed-height frame and its own
       * scrolling pane, so `documentElement.scrollHeight` is always the
       * viewport and tells us nothing. The content height is the tallest
       * `overflow: auto|scroll` box in the tree; growing the viewport to it
       * makes the pane tall enough to paint every section without scrolling,
       * which is what a reviewer needs to see.
       */
      const measure = `(() => {
        let tallest = 0;
        for (const el of document.querySelectorAll("*")) {
          const style = getComputedStyle(el);
          if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
          tallest = Math.max(tallest, el.scrollHeight);
        }
        return Math.max(tallest, document.body.scrollHeight);
      })()`;

      let height = shot.height === "auto" ? MIN_HEIGHT : shot.height;
      for (let pass = 0; pass < 3 && shot.height === "auto"; pass += 1) {
        const needed = await evaluate(measure);
        const next = Math.max(
          MIN_HEIGHT,
          Math.min(MAX_HEIGHT, Math.ceil(needed)),
        );
        if (next === height) break;
        height = next;
        await send("Emulation.setDeviceMetricsOverride", {
          width: WIDTH,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(500);
      }

      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });

      const png = path.join(SCRATCH, `${shot.name}-${theme}.png`);
      await writeFile(png, Buffer.from(data, "base64"));

      const jpg = path.join(
        OUT,
        `${shot.name}-${theme}-${WIDTH}x${height}.jpg`,
      );
      const convert = spawnSync(
        "convert",
        [png, "-strip", "-quality", "86", "-sampling-factor", "4:2:0", jpg],
        { encoding: "utf8" },
      );
      if (convert.status !== 0) {
        throw new Error(`convert failed: ${convert.stderr}`);
      }

      written.push({
        surface: shot.name,
        theme,
        file: path.basename(jpg),
        width: WIDTH,
        height,
      });
      console.log(`${path.basename(jpg)}`);
    }
  }

  ws.close();
  await cleanup();
  return written;
};

main().then(
  async (written) => {
    await writeFile(
      path.join(OUT, "capture-manifest.json"),
      `${JSON.stringify(written, null, 2)}\n`,
    );
    console.log(`\n${written.length} frames captured.`);
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
