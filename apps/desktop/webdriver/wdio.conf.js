import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import chromedriver from "chromedriver";
import SpecReporter from "@wdio/spec-reporter";
import { preview as createPreviewServer } from "vite";
import { runCheckedProcess } from "./checked-process.js";
import {
  closePreview,
  waitForPreviewCreation,
  waitForPreviewListening,
} from "./preview-lifecycle.js";
import { waitForHttpServer } from "./wait-for-http-server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let tauriDriverProcess;
let shuttingDown = false;
let previewServer;
let previewStartup;
let preparation;
let chromeDriverProcess;
let chromeDriverStartup;
const retiredChromeDrivers = new WeakSet();
const retiredTauriDrivers = new WeakSet();

const projectRoot = path.resolve(__dirname, "..");
const isMac = process.platform === "darwin";
const previewPort = Number(process.env.WDIO_PREVIEW_PORT ?? 4173);
const isHeadless = process.env.WDIO_HEADLESS !== "false";
const driverPort = isMac
  ? Number(process.env.WDIO_CHROMEDRIVER_PORT ?? 9515)
  : 4444;

// npm's CLI entrypoint is run through Node directly. Resolving the binary
// from PATH (or via a shell) would depend on whatever the invoking shell's
// PATH holds, and a plain `npm` spawn also fails on Windows without a shell.
const npmCliCandidates = [
  path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  ),
  path.join(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  ),
  // Distros that ship npm as a separate system package (Debian, Ubuntu).
  "/usr/share/nodejs/npm/bin/npm-cli.js",
  // Homebrew's Node package (Apple Silicon and Intel): the npm CLI lives
  // under the Cellar's lib/node_modules, not next to the node binary.
  "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
];
const npmCliPath = npmCliCandidates.find((candidate) =>
  fs.existsSync(candidate),
);
if (!npmCliPath) {
  throw new Error(
    "Could not locate npm-cli.js next to the running Node binary. npm ships " +
      "with Node; reinstall Node or run the E2E suite with a standard Node " +
      "installation.",
  );
}

const runNpm = (args) =>
  runCheckedProcess(process.execPath, [npmCliPath, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
  });

function resolveTauriBinary() {
  const override = process.env.TAURI_APPLICATION_PATH;
  if (override) {
    return path.resolve(projectRoot, override);
  }

  const binaryName =
    process.platform === "win32" ? "mausVoice.exe" : "mausVoice";
  return path.resolve(projectRoot, "src-tauri", "target", "debug", binaryName);
}

function ensureBinaryExists(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Expected Tauri binary at "${binaryPath}" but it was not found. ` +
        'Run "npm run tauri build -- --debug --no-bundle" inside apps/desktop to compile it.',
    );
  }
}

function resolveTauriDriver() {
  const driverName =
    process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver";
  return path.resolve(os.homedir(), ".cargo", "bin", driverName);
}

function closeTauriDriver() {
  const child = tauriDriverProcess;
  tauriDriverProcess = undefined;
  if (!child) return;
  retiredTauriDrivers.add(child);
  if (!child.killed) child.kill();
}

function resolveChromeDriverBinary() {
  const binaryPath = chromedriver?.path ?? chromedriver;
  if (!binaryPath || typeof binaryPath !== "string") {
    throw new Error("Could not resolve chromedriver binary path.");
  }
  return binaryPath;
}

async function startChromeDriver() {
  if (chromeDriverProcess) {
    return;
  }

  const child = spawn(
    resolveChromeDriverBinary(),
    [`--port=${driverPort}`, "--url-base=/", "--allowed-ips=127.0.0.1"],
    {
      stdio: ["ignore", "pipe", process.stderr],
    },
  );

  chromeDriverProcess = child;
  const controller = new AbortController();
  chromeDriverStartup = { child, controller };
  child.stdout.on("data", (data) => {
    process.stdout.write(data);
  });

  child.on("error", (error) => {
    if (chromeDriverProcess !== child || retiredChromeDrivers.has(child))
      return;
    controller.abort(error);
    previewStartup?.abort(error);
    console.error("chromedriver error:", error);
  });

  child.on("exit", (code) => {
    const isCurrent = chromeDriverProcess === child;
    if (isCurrent) chromeDriverProcess = undefined;
    if (isCurrent && !shuttingDown && !retiredChromeDrivers.has(child)) {
      const error = new Error(
        `ChromeDriver exited unexpectedly (code ${code ?? "unknown"})`,
      );
      controller.abort(error);
      previewStartup?.abort(error);
      console.error("chromedriver exited unexpectedly with code:", code);
    }
  });

  try {
    await waitForHttpServer({ port: driverPort, signal: controller.signal });
    controller.signal.throwIfAborted();
  } catch (error) {
    if (chromeDriverProcess === child) closeChromeDriver();
    throw error;
  } finally {
    if (chromeDriverStartup?.child === child) chromeDriverStartup = undefined;
  }
}

function closeChromeDriver() {
  const child = chromeDriverProcess;
  chromeDriverProcess = undefined;
  if (!child) return;
  retiredChromeDrivers.add(child);
  if (chromeDriverStartup?.child === child) {
    chromeDriverStartup.controller.abort(new Error("ChromeDriver was retired"));
    chromeDriverStartup = undefined;
  }
  if (!child.killed) child.kill();
}

async function startPreviewServer() {
  if (previewServer) return;
  const controller = new AbortController();
  previewStartup = controller;
  let server;
  try {
    server = await waitForPreviewCreation(
      createPreviewServer({
        root: projectRoot,
        configFile: path.resolve(projectRoot, "vite.config.ts"),
        preview: { host: "127.0.0.1", port: previewPort, open: false },
      }),
      controller.signal,
    );
    if (controller.signal.aborted) {
      closePreview(server);
      controller.signal.throwIfAborted();
    }
    previewServer = server;
    await waitForPreviewListening(server, controller.signal);
  } catch (error) {
    if (previewServer === server && server) closePreviewServer();
    throw error;
  } finally {
    if (previewStartup === controller) previewStartup = undefined;
  }
}

function closePreviewServer() {
  const controller = previewStartup;
  previewStartup = undefined;
  controller?.abort(new Error("Preview server was retired"));
  const server = previewServer;
  previewServer = undefined;
  if (server) closePreview(server);
}

function registerShutdownHooks() {
  const cleanup = () => {
    shuttingDown = true;
    try {
      closeTauriDriver();
      closePreviewServer();
      closeChromeDriver();
    } finally {
      process.exit();
    }
  };

  process.on("exit", () => {
    shuttingDown = true;
    closeTauriDriver();
    closePreviewServer();
    closeChromeDriver();
  });
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("SIGBREAK", cleanup);
}

registerShutdownHooks();

const chromeArgs = [
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1280,800",
];

if (isHeadless) {
  chromeArgs.push("--headless=new");
}

const baseCapabilities = isMac
  ? [
      {
        browserName: "chrome",
        "goog:chromeOptions": {
          args: chromeArgs,
        },
      },
    ]
  : [
      {
        maxInstances: 1,
        "tauri:options": {
          application: resolveTauriBinary(),
        },
      },
    ];

async function prepareApplication() {
  if (isMac) {
    runNpm(["run", "build"]);
    await startChromeDriver();
    try {
      await startPreviewServer();
    } catch (error) {
      closeChromeDriver();
      throw error;
    }
    return;
  }
  runNpm(["run", "tauri", "build", "--", "--debug", "--no-bundle"]);
  ensureBinaryExists(resolveTauriBinary());
}

function prepareOnce() {
  if (preparation) return preparation;
  const pending = prepareApplication().finally(() => {
    if (preparation === pending) preparation = undefined;
  });
  preparation = pending;
  return pending;
}

export const config = {
  runner: "local",
  host: "127.0.0.1",
  port: driverPort,
  path: "/",
  specs: ["./specs/**/*.spec.ts"],
  logLevel: "info",
  maxInstances: 1,
  automationProtocol: "webdriver",
  services: [],
  baseUrl: isMac ? `http://127.0.0.1:${previewPort}` : undefined,
  capabilities: baseCapabilities,
  autoCompileOpts: {
    tsNodeOpts: {
      project: path.resolve(__dirname, "tsconfig.json"),
      transpileOnly: true,
    },
  },
  reporters: [SpecReporter],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
  before: isMac
    ? async () => {
        if (typeof browser !== "undefined") {
          await browser.url("/");
        }
      }
    : undefined,
  // Build fresh artifacts, sharing in-flight work between concurrent callers.
  onPrepare: prepareOnce,
  beforeSession: isMac
    ? undefined
    : () => {
        const tauriDriverPath = resolveTauriDriver();

        if (!fs.existsSync(tauriDriverPath)) {
          throw new Error(
            `Could not find tauri-driver at "${tauriDriverPath}". ` +
              'Install it with "cargo install tauri-driver".',
          );
        }

        if (tauriDriverProcess) {
          throw new Error("A tauri-driver is already owned by this session.");
        }
        const child = spawn(tauriDriverPath, [], {
          stdio: ["ignore", process.stdout, process.stderr],
        });
        tauriDriverProcess = child;

        child.on("error", (error) => {
          if (
            shuttingDown ||
            retiredTauriDrivers.has(child) ||
            tauriDriverProcess !== child
          )
            return;
          console.error("tauri-driver error:", error);
          process.exit(1);
        });

        child.on("exit", (code) => {
          const isCurrent = tauriDriverProcess === child;
          if (isCurrent) tauriDriverProcess = undefined;
          if (isCurrent && !shuttingDown && !retiredTauriDrivers.has(child)) {
            console.error("tauri-driver exited unexpectedly with code:", code);
            // A clean exit is still a failed session when it was not requested.
            process.exit(code || 1);
          }
        });
      },
  afterSession: () => {
    if (isMac) {
      closePreviewServer();
      closeChromeDriver();
    } else {
      closeTauriDriver();
    }
  },
};
