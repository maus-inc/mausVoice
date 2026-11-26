/**
 * Figures whose surface is a real React component, captured from the preview
 * app. The ids here are owned by `capture-preview.mjs`; `capture-guides.mjs`
 * skips them so the two scripts never write the same file.
 *
 * Native surfaces (the pill, the native review panel) are drawn by the Rust
 * layer and have no DOM, so they cannot be captured this way.
 */
export const PREVIEW_FIGURES = {
  "home-heatmap": { route: "/#/c/home-heatmap", target: "home-heatmap" },
};
