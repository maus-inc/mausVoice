import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { vendorManualChunk } from "./scripts/vendor-manual-chunk.mjs";

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
      // white window. Same-origin module loading does not need it. Strip it
      // only from <script>/<link> tags so we never touch inline strings.
      {
        name: "tauri-strip-crossorigin",
        transformIndexHtml(html) {
          // Strip crossorigin from real <script>/<link> opening tags only. The
          // `(?=[\s/>])` after the tag name ignores <script-foo>, and the
          // trailing `(?=[\s/>])` keeps attribute-like substrings (e.g.
          // crossoriginness) untouched. One linear pattern (no nested
          // quantifiers, no alternation) keeps SonarCloud's complexity and
          // backtracking checks quiet.
          return html.replace(
            /((?:<(?:script|link)(?=[\s/>])[^>]*?))\scrossorigin( ?= ?[^\s>]*)?(?=[\s/>])/gi,
            "$1",
          );
        },
      },
    ],
    resolve: {
      conditions:
        process.env.NODE_ENV === "production"
          ? ["import", "module", "browser", "default"]
          : ["development", "import", "module", "browser", "default"],
    },
    clearScreen: false,
    build: {
      rollupOptions: {
        output: {
          // Split heavy vendors out of the app bundle. React-family packages
          // that read React at module-init time stay in the React chunk —
          // a dedicated intl chunk crashed startup with
          // `Cannot read properties of undefined (reading 'Fragment')`.
          manualChunks: vendorManualChunk,
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
