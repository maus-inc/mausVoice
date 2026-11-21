// Minimal Chrome DevTools Protocol driver.
//
// The sandbox blocks cdn.playwright.dev and storage.googleapis.com, so no
// Playwright browser can be downloaded. It does reach registry.npmjs.org, and
// @sparticuz/chromium ships a full Chromium inside the npm tarball. This file
// drives that binary directly over CDP, which needs no client library.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
import { CHROMIUM_LAUNCH_FLAGS } from "./browser-config.mjs";

// Both the browser and its libraries live under /tmp, which this environment
// wipes between turns. Rather than fail with a confusing spawn error, extract
// them on demand the first time a browser is actually launched.
// install-chromium.mjs is idempotent, so a warm directory costs one check.
const CHR_DIR = process.env.CHROMIUM_DIR || "/tmp/chr";
const CHROME = process.env.CHROMIUM_PATH || join(CHR_DIR, "chromium");
const LIB = join(CHR_DIR, "lib");

/**
 * Ensures a browser exists, extracting one if not.
 *
 * Called from `launch`, never from module scope: importing this file used to run
 * an install, unpack a ~150 MB archive and write to the filesystem. That is a
 * surprising side effect for an `import` -- a test that only wanted the port
 * helpers would still hit the network and the disk, and a sandbox with no npm
 * reachability would fail at import time with an error pointing at this file
 * rather than at whatever asked for a browser.
 */
function ensureChromium() {
  if (existsSync(CHROME)) {
    return;
  }
  const installer = join(import.meta.dirname, "install-chromium.mjs");
  console.error(`No Chromium at ${CHROME}; extracting one …`);
  execFileSync(process.execPath, [installer, "--dir", CHR_DIR], {
    stdio: "inherit",
  });
  if (!existsSync(CHROME)) throw new Error(`no chromium at ${CHROME}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: 4000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`bad json from ${path}: ${error.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

/** A port nobody is listening on, asked for and then released. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const version = await httpJson(port, "/json/version").catch(() => null);
    if (version?.webSocketDebuggerUrl) return version;
    await sleep(250);
  }
  return null;
}

function manageChromiumProcess(proc, profile) {
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.off("exit", cleanup);
    process.off("SIGINT", interrupt);
    if (proc.exitCode === null && proc.signalCode === null)
      proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };
  const interrupt = () => {
    cleanup();
    process.exit(130);
  };
  process.once("exit", cleanup);
  process.once("SIGINT", interrupt);
  return cleanup;
}

export async function launch({ port, width = 1280, height = 900 } = {}) {
  // A fixed port collides with a browser left over from an earlier run, and the
  // symptom is a misleading "never opened its debugging port" rather than an
  // address-in-use error. Ask the OS instead.
  port = port ?? (await freePort());
  ensureChromium();
  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
  const proc = spawn(
    CHROME,
    [
      ...CHROMIUM_LAUNCH_FLAGS,
      "--disable-software-rasterizer",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${LIB}:${process.env.LD_LIBRARY_PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  proc.stdout.on("data", (d) => (logs += d));
  proc.stderr.on("data", (d) => (logs += d));

  const cleanup = manageChromiumProcess(proc, profile);
  const version = await waitForDebugger(port);
  if (!version) {
    cleanup();
    throw new Error(
      `chromium never opened its debugging port\n${logs.slice(-2000)}`,
    );
  }

  return { proc, port, version, logs: () => logs, cleanup };
}

function settleReply(pending, message) {
  const reply = pending.get(message.id);
  if (!reply) return;
  pending.delete(message.id);
  clearTimeout(reply.timer);
  if (message.error) reply.reject(new Error(JSON.stringify(message.error)));
  else reply.resolve(message.result);
}

/** A tab with a request/response CDP session over the raw WebSocket. */
export async function newPage(port) {
  const tab = await httpJson(port, "/json/new?about:blank").catch(async () => {
    // Older builds need PUT for /json/new.
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/json/new?about:blank",
          method: "PUT",
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(JSON.parse(body)));
        },
      );
      req.on("error", reject);
      req.end();
    });
  });

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp socket failed")), {
      once: true,
    });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      settleReply(pending, message);
      return;
    }
    for (const listener of listeners.get(message.method) ?? [])
      listener(message.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 30_000);
      // Neither holds the process open by itself: every reply clears it, and a
      // socket that dies without replying must not pin the script for 30 s
      // either.
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  const goto = async (url) => {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
  };

  const screenshot = async () => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  };

  const setViewport = async (width, height, scale = 1) =>
    send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });

  const close = () => ws.close();

  return {
    send,
    on,
    evaluate,
    goto,
    screenshot,
    setViewport,
    close,
    pageId: tab.id,
  };
}

// Re-exported so the scripts that drive a browser can import both from one
// place. The implementation lives in `wait-for-truthy.mjs` because importing it
// must not trigger the Chromium check this module performs on load.
export { sleep, waitForTruthy } from "./wait-for-truthy.mjs";
