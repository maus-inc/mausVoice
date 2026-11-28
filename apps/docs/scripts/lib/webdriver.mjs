/**
 * Drives the built desktop app over WebDriver so guide figures come from the
 * running product rather than a redrawn copy of it.
 *
 * `tauri-driver` must already be listening (see `scripts/capture-app.mjs` for
 * how it is started) and the app must be able to serve its renderer. The
 * session it creates is the same one `apps/desktop/webdriver` uses for the end
 * to end suite.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll `read` until it returns a truthy value, so a late render is not a failure. */
export const poll = async (read, message, attempts = 60) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value) return value;
    await sleep(250); // NOSONAR javascript:S9382 ordered polling, one wait at a time
  }
  throw new Error(message);
};

const request = async (baseUrl, path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  }
  return body.value;
};

/** Open a session on the app binary, through the running driver. */
export const openSession = async (baseUrl, application) => {
  const value = await request(baseUrl, "/session", {
    method: "POST",
    body: JSON.stringify({
      capabilities: { alwaysMatch: { "tauri:options": { application } } },
    }),
  });
  return new Session(baseUrl, value.sessionId);
};

class Session {
  constructor(baseUrl, id) {
    this.baseUrl = baseUrl;
    this.id = id;
  }

  path(suffix = "") {
    return `/session/${this.id}${suffix}`;
  }

  async navigate(url) {
    await request(this.baseUrl, this.path("/url"), {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    await this.execute("return document.fonts.ready.then(() => true)");
    await sleep(250);
  }

  /** Run `script` in the page. The body is the function body, not an expression. */
  async execute(script) {
    return request(this.baseUrl, this.path("/execute/sync"), {
      method: "POST",
      body: JSON.stringify({ script, args: [] }),
    });
  }

  /** Evaluate `expression`, the shape the marker and figure helpers use. */
  async evaluate(expression) {
    return this.execute(`return (${expression})`);
  }

  async box(selector) {
    return this.execute(`return (() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
  }

  async screenshot() {
    const data = await request(this.baseUrl, this.path("/screenshot"));
    return Buffer.from(data, "base64");
  }

  async close() {
    await request(this.baseUrl, this.path(), { method: "DELETE" }).catch(
      () => {},
    );
  }
}

/**
 * Screenshot the whole window, crop it to `box` plus `padding` and upscale it
 * by `scale`, so a figure matches the window at the retina density the docs
 * site renders.
 */
export const captureRegion = async (session, box, { padding = 0, scale = 2 }) => {
  const inset =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : { top: 0, right: 0, bottom: 0, left: 0, ...padding };
  const dir = await mkdtemp(join(tmpdir(), "guide-shot-"));
  const full = join(dir, "window.png");
  const cropped = join(dir, "crop.png");
  await writeFile(full, await session.screenshot());
  const x = Math.max(0, Math.round(box.x - inset.left));
  const y = Math.max(0, Math.round(box.y - inset.top));
  const width = Math.round(box.width + inset.left + inset.right);
  const height = Math.round(box.height + inset.top + inset.bottom);
  const filters = [
    `crop=${width}:${height}:${x}:${y}`,
    scale === 1 ? null : `scale=iw*${scale}:ih*${scale}:flags=lanczos`,
  ]
    .filter(Boolean)
    .join(",");
  await run("ffmpeg", [
    "-y",
    "-i",
    full,
    "-vf",
    filters,
    "-frames:v",
    "1",
    cropped,
    "-loglevel",
    "error",
  ]);
  return readFile(cropped);
};
