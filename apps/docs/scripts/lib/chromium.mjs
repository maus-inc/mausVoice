/**
 * Minimal headless Chromium driver over the DevTools protocol.
 *
 * Uses Node's built-in WebSocket so the capture scripts need no Playwright
 * install. Chromium must be on PATH as `chromium`, or named with CHROMIUM_BIN.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserBin = process.env.CHROMIUM_BIN ?? "chromium";
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const readPort = async (profileDir) => {
  const marker = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const [port] = (await readFile(marker, "utf8")).split("\n");
      if (port) return Number(port);
    } catch {
      // Chromium writes the marker once the DevTools listener is up.
    }
    await sleep(250);
  }
  throw new Error("Chromium did not report a DevTools port");
};

const connect = async (port) => {
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

/**
 * Launch headless Chromium, hand a connected client to `run`, then shut the
 * browser down. Chromium's own output is printed only when `run` throws, since
 * it is the only clue when a launch or navigation fails.
 */
export const withChromium = async (run) => {
  const profileDir = await mkdtemp(join(tmpdir(), "mausvoice-capture-"));
  const browser = spawn(
    browserBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,1200",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let browserLog = "";
  for (const stream of [browser.stdout, browser.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      browserLog = (browserLog + chunk).slice(-4000);
    });
  }

  try {
    const client = createClient(await connect(await readPort(profileDir)));
    await client.ready;
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const result = await run(client);
    client.close();
    return result;
  } catch (error) {
    if (browserLog) console.error(browserLog.trimEnd());
    throw error;
  } finally {
    browser.kill("SIGTERM");
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
};
