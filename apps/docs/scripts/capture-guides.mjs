/**
 * Capture the visual-guide figures that redraw a native surface.
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
import { PREVIEW_FIGURES } from "./figures.mjs";
import {
  captureBox,
  navigate,
  readOptions,
  runCapture,
} from "./lib/capture.mjs";

const stageUrl = new URL("./figure-stage.html", import.meta.url);

const stageBoxes = `
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
`;

const { only, scale } = readOptions(process.argv.slice(2));

runCapture(async (client) => {
  await navigate(client, `${stageUrl.href}?theme=dark`);

  const boxes = await client.evaluate(stageBoxes);
  const files = [];
  for (const box of boxes) {
    if (only && box.id !== only) continue;
    if (box.id in PREVIEW_FIGURES) continue;
    files.push(await captureBox(client, box, scale, box.id));
  }
  return files;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
