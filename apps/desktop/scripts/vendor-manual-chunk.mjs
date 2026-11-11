/**
 * Rollup `manualChunks` helper for the desktop Vite build.
 *
 * React and any library that reads `React.Fragment` (or other React exports)
 * at module-init time MUST share a chunk. A dedicated `intl` chunk left
 * React's default export uninitialized under Rollup's interop, so
 * `React.Fragment` threw and the main window rendered a blank white page.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
export function vendorManualChunk(id) {
  const normalized = id.replaceAll("\\", "/");
  if (!normalized.includes("node_modules/")) {
    return undefined;
  }

  if (isReactRuntime(normalized) || isReactInitConsumer(normalized)) {
    return "react";
  }
  if (normalized.includes("/@mui/")) return "mui";
  if (normalized.includes("/framer-motion/")) return "motion";
  if (normalized.includes("/firebase/")) return "firebase";
  if (normalized.includes("/lodash-es/")) return "lodash";
  if (normalized.includes("/rxjs/")) return "rxjs";
  if (normalized.includes("/react-router")) return "router";
  if (normalized.includes("/@tauri-apps/")) return "tauri";
  return undefined;
}

/** @param {string} id */
function isReactRuntime(id) {
  return (
    id.includes("/react/") ||
    id.includes("/react-dom/") ||
    id.includes("/scheduler/") ||
    id.includes("/react-is/")
  );
}

/** @param {string} id */
function isReactInitConsumer(id) {
  return (
    id.includes("/react-intl/") ||
    id.includes("/@formatjs/") ||
    id.includes("/intl-messageformat")
  );
}
