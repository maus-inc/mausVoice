/**
 * Capture guide figures from the real components, rendered by the preview app.
 *
 * Usage:
 *   node apps/docs/scripts/capture-preview.mjs [--only <id>] [--scale 2]
 *
 * Start the preview first (`pnpm --filter @maus-inc/preview dev`), then run
 * this. It opens the preview route for each figure in headless Chromium with a
 * dark colour scheme, screenshots the element carrying `data-capture="<id>"`,
 * and writes `apps/docs/public/guides/<id>.png`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW_FIGURES } from "./figures.mjs";
import { sleep, withChromium } from "./lib/chromium.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, "..", "public", "guides");
const baseUrl = process.env.PREVIEW_URL ?? "http://127.0.0.1:5193";

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const scaleIndex = args.indexOf("--scale");
const scale = scaleIndex >= 0 ? Number(args[scaleIndex + 1]) : 2;

const boxFor = (target) => `
  (() => {
    const node = document.querySelector('[data-capture="${target}"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  })()
`;

const main = async () => {
  await mkdir(outputDir, { recursive: true });
  const written = await withChromium(async (client) => {
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });

    const files = [];
    let loadedRoute = null;
    for (const [id, recipe] of Object.entries(PREVIEW_FIGURES)) {
      if (only && id !== only) continue;
      if (recipe.route !== loadedRoute) {
        const loaded = client.once("Page.loadEventFired");
        await client.send("Page.navigate", { url: `${baseUrl}${recipe.route}` });
        await loaded;
        await client.evaluate("document.fonts.ready.then(() => true)");
        loadedRoute = recipe.route;
      }

      let box = null;
      for (let attempt = 0; attempt < 60 && !box; attempt += 1) {
        box = await client.evaluate(boxFor(recipe.target ?? id));
        if (!box) await sleep(250);
      }
      if (!box) throw new Error(`capture target ${id} never rendered`);

      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { ...box, scale },
      });
      const file = join(outputDir, `${id}.png`);
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
