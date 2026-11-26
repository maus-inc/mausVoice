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
import { PREVIEW_FIGURES } from "./figures.mjs";
import {
  captureBox,
  navigate,
  readOptions,
  runCapture,
  waitForBox,
} from "./lib/capture.mjs";

const baseUrl = process.env.PREVIEW_URL ?? "http://127.0.0.1:5193";

const boxExpression = (target) => `
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

const captureFigure = async (client, id, recipe, loaded, scale) => {
  if (recipe.route !== loaded.route) {
    await navigate(client, `${baseUrl}${recipe.route}`);
    loaded.route = recipe.route;
  }
  const box = await waitForBox(client, boxExpression(recipe.target ?? id));
  if (!box) throw new Error(`capture target ${id} never rendered`);
  return captureBox(client, box, scale, id);
};

const captureAll = async (client, scale, only) => {
  const loaded = { route: null };
  const files = [];
  for (const [id, recipe] of Object.entries(PREVIEW_FIGURES)) {
    if (!only || id === only) {
      files.push(await captureFigure(client, id, recipe, loaded, scale));
    }
  }
  return files;
};

const { only, scale } = readOptions(process.argv.slice(2));

runCapture(async (client) => {
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  return captureAll(client, scale, only);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
