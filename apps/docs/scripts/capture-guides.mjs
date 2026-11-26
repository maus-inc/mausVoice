/**
 * Capture the visual-guide figures to PNG.
 *
 * Usage:
 *   node apps/docs/scripts/capture-guides.mjs [--only <id>] [--scale 2]
 *
 * The script renders `apps/docs/scripts/figure-stage.html` in headless
 * Chromium with the dark theme, screenshots every `[data-figure]` element by
 * its layout box, and writes `apps/docs/public/guides/<id>.png`.
 *
 * Figures whose surface is a real React component live in `figures.mjs` and
 * are captured from the preview app by `capture-preview.mjs` instead; this
 * script skips them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PREVIEW_FIGURES } from "./figures.mjs";
import { sleep, withChromium } from "./lib/chromium.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, "..");
const stageFile = join(here, "figure-stage.html");
const outputDir = join(docsRoot, "public", "guides");

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const scaleIndex = args.indexOf("--scale");
const scale = scaleIndex >= 0 ? Number(args[scaleIndex + 1]) : 2;

const main = async () => {
  await mkdir(outputDir, { recursive: true });
  const written = await withChromium(async (client) => {
    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", {
      url: `${pathToFileURL(stageFile).href}?theme=dark`,
    });
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

    const files = [];
    for (const figure of figures) {
      if (only && figure.id !== only) continue;
      if (figure.id in PREVIEW_FIGURES) continue;
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
      const file = join(outputDir, `${figure.id}.png`);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      files.push(file);
    }
    return files;
  });

  console.log(`captured ${written.length} images`);
  for (const file of written) console.log(`  ${file}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
