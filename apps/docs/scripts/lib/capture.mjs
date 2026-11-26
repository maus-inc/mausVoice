/**
 * Shared plumbing for the guide figure capture scripts.
 *
 * Both scripts open a page in headless Chromium, wait for it to settle, take a
 * clipped screenshot of one element per figure, and write it to
 * `apps/docs/public/guides/<id>.png`. Only the page and the element lookup
 * differ between them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, withChromium } from "./chromium.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const outputDir = resolve(here, "..", "..", "public", "guides");

export const readOptions = (argv) => {
  const onlyIndex = argv.indexOf("--only");
  const scaleIndex = argv.indexOf("--scale");
  return {
    only: onlyIndex >= 0 ? argv[onlyIndex + 1] : null,
    scale: scaleIndex >= 0 ? Number(argv[scaleIndex + 1]) : 2,
  };
};

/** Navigate, wait for the load event and for webfonts, then let layout settle. */
export const navigate = async (client, url) => {
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
  await client.evaluate("document.fonts.ready.then(() => true)");
  await sleep(250);
};

/** Poll an expression until it returns a layout box, so a late render is not a failure. */
export const waitForBox = async (client, expression, attempts = 60) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const box = await client.evaluate(expression);
    if (box) return box;
    await sleep(250);
  }
  return null;
};

export const captureBox = async (client, box, scale, id) => {
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...box, scale },
  });
  const file = join(outputDir, `${id}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
};

/** Capture every box that survives `keep`, skipping ids the caller rejects. */
export const captureBoxes = async (client, boxes, scale, keep = () => true) => {
  const files = [];
  for (const box of boxes) {
    if (keep(box)) files.push(await captureBox(client, box, scale, box.id));
  }
  return files;
};

/**
 * Run a capture pass and print what it wrote. `run` receives the connected
 * client and returns the files it wrote.
 */
export const runCapture = async (run) => {
  await mkdir(outputDir, { recursive: true });
  const files = await withChromium(run);
  console.log(`captured ${files.length} images`);
  for (const file of files) console.log(`  ${file}`);
};
