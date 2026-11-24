/**
 * Capture the visual-guide figures to PNG.
 *
 * Usage:
 *   node apps/docs/scripts/capture-guides.mjs [--only <id>] [--scale 2]
 *
 * The script renders `apps/docs/scripts/figure-stage.html` in headless
 * Chromium twice, once per theme, screenshots every `[data-figure]` element by
 * its layout box, and writes `apps/docs/public/guides/<id>-<theme>.png`.
 *
 * It drives Chromium over the DevTools protocol with Node's built-in
 * WebSocket, so it needs no Playwright install. Chromium must be on PATH as
 * `chromium`, or named with CHROMIUM_BIN.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, "..");
const stageFile = join(here, "figure-stage.html");
const outputDir = join(docsRoot, "public", "guides");
const port = 9333;
const browserBin = process.env.CHROMIUM_BIN ?? "chromium";

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const scaleIndex = args.indexOf("--scale");
const scale = scaleIndex >= 0 ? Number(args[scaleIndex + 1]) : 2;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const connect = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Browser is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chromium DevTools endpoint did not become ready");
};

const createClient = (url) => {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const events = new Map();

  const ready = new Promise((done, fail) => {
    socket.addEventListener("open", () => done());
    socket.addEventListener("error", (event) => fail(event.error ?? event));
  });

  const settle = (payload) => {
    const { resolve: done, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(new Error(payload.error.message));
    else done(payload.result);
  };

  const dispatch = (payload) => {
    const listeners = events.get(payload.method);
    if (listeners) listeners.forEach((listener) => listener(payload.params));
  };

  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(message.data);
    if (payload.id && pending.has(payload.id)) settle(payload);
    else dispatch(payload);
  });

  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: done, reject: fail });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const once = (method) =>
    new Promise((done) => {
      const listener = (params) => {
        const listeners = events.get(method) ?? [];
        events.set(
          method,
          listeners.filter((entry) => entry !== listener),
        );
        done(params);
      };
      events.set(method, [...(events.get(method) ?? []), listener]);
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result.value;
  };

  return { ready, send, once, evaluate, close: () => socket.close() };
};

const captureTheme = async (client, theme) => {
  const url = `${pathToFileURL(stageFile).href}?theme=${theme}`;
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
  await client.evaluate("document.fonts.ready.then(() => true)");
  await sleep(250);

  const figures = await client.evaluate(`
    Array.from(document.querySelectorAll("[data-figure]")).map((node) => {
      const box = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-figure"),
        x: box.x + window.scrollX,
        y: box.y + window.scrollY,
        width: box.width,
        height: box.height,
      };
    })
  `);

  const written = [];
  for (const figure of figures) {
    if (only && figure.id !== only) continue;
    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: figure.x,
        y: figure.y,
        width: figure.width,
        height: figure.height,
        scale,
      },
    });
    const file = join(outputDir, `${figure.id}-${theme}.png`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    written.push(file);
  }
  return written;
};

const main = async () => {
  await mkdir(outputDir, { recursive: true });
  const browser = spawn(
    browserBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${port}`,
      "--window-size=1440,1200",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const socketUrl = await connect();
    const client = createClient(socketUrl);
    await client.ready;
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const light = await captureTheme(client, "light");
    const dark = await captureTheme(client, "dark");
    client.close();
    console.log(`captured ${light.length + dark.length} images`);
    for (const file of [...light, ...dark]) console.log(`  ${file}`);
  } finally {
    browser.kill("SIGTERM");
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
