import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => {
  const { formatjsOverrideIdFn } = await import("./scripts/formatjs-id.mjs");

  return {
    // Relative base so the built index.html references ./assets/* instead of
    // /assets/*. Tauri serves the release frontend over the asset: protocol,
    // where absolute paths + the crossorigin module attribute can fail to
    // load — leaving a blank white window with no script execution.
    base: "./",
    plugins: [
      react({
        babel: {
          plugins: [
            [
              "babel-plugin-formatjs",
              {
                overrideIdFn: (
                  id: string | undefined,
                  defaultMessage: string | undefined,
                  description: string | undefined,
                  filePath: string | undefined,
                ) =>
                  formatjsOverrideIdFn(
                    id,
                    defaultMessage,
                    description,
                    filePath,
                  ) ?? id,
                ast: true,
              },
            ],
          ],
        },
      }),
      svgr(),
      // Tauri serves the release frontend over the asset: protocol. The
      // `crossorigin` attribute Vite adds to module/preload tags forces a
      // CORS-mode fetch that the asset server can reject, leaving a blank
      // white window. Same-origin module loading does not need it.
      {
        name: "tauri-strip-crossorigin",
        transformIndexHtml(html) {
          return html.replaceAll(" crossorigin", "");
        },
      },
    ],
    clearScreen: false,
    build: {
      rollupOptions: {
        output: {
          // Split the heavy vendors out of the app bundle so the initial chunk
          // stays lean and vendor updates don't invalidate the app chunk.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/") ||
              id.includes("/react-is/")
            ) {
              return "react";
            }
            if (id.includes("/@mui/")) return "mui";
            if (id.includes("/framer-motion/")) return "motion";
            if (id.includes("/firebase/")) return "firebase";
            if (id.includes("/lodash-es/")) return "lodash";
            if (id.includes("/rxjs/")) return "rxjs";
            if (
              id.includes("/react-intl/") ||
              id.includes("/@formatjs/") ||
              id.includes("/intl-messageformat")
            ) {
              return "intl";
            }
            if (id.includes("/react-router")) return "router";
            if (id.includes("/@tauri-apps/")) return "tauri";
            return undefined;
          },
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
