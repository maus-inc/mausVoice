/**
 * Annotation markers for figures captured from a real component.
 *
 * A capture is a screenshot, so the badge cannot live in the component's own
 * markup. Each marker is resolved to an element inside the capture root and
 * painted into an overlay span sized to that element's box. The badge itself
 * comes from `src/styles/guide-markers.css`, which is injected unchanged, so
 * every figure in the guides draws the same badge.
 *
 * The overlay never touches the target's layout or scroll container, and it is
 * removed after the screenshot, so the next figure starts clean.
 */
import { readFile } from "node:fs/promises";

const markerCss = await readFile(
  new URL("../../src/styles/guide-markers.css", import.meta.url),
  "utf8",
);

const PLACEMENTS = new Set([
  "start",
  "after",
  "above",
  "above-start",
  "right",
  "below",
]);

/**
 * Paint `markers` inside `root`, a CSS selector for the captured region.
 * `pick` chooses among several matches, `"first"`, `"middle"` or `"last"`, and
 * `visible` drops the matches a scroll container has scrolled out of sight, so
 * a badge lands on something the screenshot actually shows. With neither, a
 * selector must match exactly one element, so a rename fails the capture
 * instead of putting the badge on the wrong surface.
 */
export const drawMarkers = async (client, root, markers = []) => {
  for (const marker of markers) {
    if (!marker.selector) {
      throw new Error(`marker ${marker.n} has no selector`);
    }
    if (marker.placement && !PLACEMENTS.has(marker.placement)) {
      throw new Error(
        `marker ${marker.n} placement "${marker.placement}" is not one of ${[...PLACEMENTS].join(", ")}`,
      );
    }
    if (marker.pick && !["first", "middle", "last"].includes(marker.pick)) {
      throw new Error(`marker ${marker.n} pick "${marker.pick}" is not first, middle or last`);
    }
  }
  if (markers.length === 0) return 0;

  const expression = `(() => {
  const css = ${JSON.stringify(markerCss)};
  const markers = ${JSON.stringify(markers)};
  const root = document.querySelector(${JSON.stringify(root)});
  if (!root) throw new Error("capture root " + ${JSON.stringify(root)} + " is not on the page");
  const style = document.createElement("style");
  style.id = "guide-marker-style";
  style.textContent = css;
  document.head.appendChild(style);
  const layer = document.createElement("div");
  layer.id = "guide-marker-layer";
  layer.style.cssText = [
    "position: absolute",
    "top: 0",
    "left: 0",
    "width: 0",
    "height: 0",
    "pointer-events: none",
    "z-index: 2147483647",
    "--mv-marker-ring: " + getComputedStyle(root).backgroundColor,
  ].join("; ");
  document.documentElement.appendChild(layer);
  const rootBox = root.getBoundingClientRect();
  const onScreen = (node) => {
    const box = node.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.right > rootBox.left &&
      box.left < rootBox.right &&
      box.bottom > rootBox.top &&
      box.top < rootBox.bottom
    );
  };
  for (const marker of markers) {
    const found = [...root.querySelectorAll(marker.selector)];
    const matches = marker.visible ? found.filter(onScreen) : found;
    const picks = {
      first: 0,
      middle: Math.floor(matches.length / 2),
      last: matches.length - 1,
    };
    const index = marker.pick ? picks[marker.pick] : matches.length === 1 ? 0 : -1;
    const node = index >= 0 ? matches[index] : null;
    if (!node) {
      throw new Error(
        "marker " + marker.n + " matched " + matches.length + " elements for " + marker.selector,
      );
    }
    const box = node.getBoundingClientRect();
    const span = document.createElement("span");
    span.className =
      "mv-anchor" + (marker.placement ? " mv-anchor--" + marker.placement : "");
    span.dataset.n = String(marker.n);
    span.style.cssText = [
      "position: absolute",
      "left: " + (box.x + window.scrollX) + "px",
      "top: " + (box.y + window.scrollY) + "px",
      "width: " + box.width + "px",
      "height: " + box.height + "px",
    ].join("; ");
    layer.appendChild(span);
  }
  return markers.length;
})()`;

  return client.evaluate(expression);
};

export const clearMarkers = async (client) => {
  await client.evaluate(
    `(() => {
  document.getElementById("guide-marker-layer")?.remove();
  document.getElementById("guide-marker-style")?.remove();
})()`,
  );
};
