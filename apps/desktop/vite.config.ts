import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { vendorManualChunk } from "./scripts/vendor-manual-chunk.mjs";

const host = process.env.TAURI_DEV_HOST;
const GLADIA_BROWSER_PEERS = ["fs", "path", "undici", "ws"] as const;

export const getGladiaBrowserPeer = (source: string) =>
  GLADIA_BROWSER_PEERS.find(
    (peer) => source === peer || source.startsWith(`${peer}/`),
  );

// Matches the SDK package directory itself (`/@gladiaio/sdk/` or the
// package as a whole), not a sibling like `@gladiaio/sdk-extras`.
const GLADIA_SDK_PATH = /(?:^|[\\/])@gladiaio[\\/]sdk(?:$|[\\/])/;

export const isGladiaSdkModule = (importer: string | undefined): boolean =>
  importer !== undefined && GLADIA_SDK_PATH.test(importer);

// Gladia's isomorphic SDK contains guarded dynamic imports for Node-only
// file uploads and network fallbacks. Tauri always provides browser
// fetch/WebSocket and passes File objects, but Rollup would otherwise
// bundle optional `undici`/`ws` peers and externalize dozens of Node
// built-ins. Replace only imports originating inside the SDK, and fail the
// build if the SDK is in the graph but no stub applied: a bumped SDK that
// switches to `node:`-prefixed builtins would otherwise silently bundle
// `undici`/`ws` outside the CSP-governed webview transport.
const gladiaBrowserPeerStubs = (): Plugin => {
  let sawGladiaSdk = false;
  let appliedPeerStubs = 0;
  return {
    name: "gladia-browser-peer-stubs",
    enforce: "pre",
    buildStart() {
      sawGladiaSdk = false;
      appliedPeerStubs = 0;
    },
    resolveId(source, importer) {
      const fromSdk = isGladiaSdkModule(importer);
      sawGladiaSdk ||= fromSdk;
      const peer = getGladiaBrowserPeer(source);
      if (fromSdk && peer) {
        appliedPeerStubs += 1;
        return `\0gladia-browser-peer:${peer}`;
      }
      return null;
    },
    buildEnd() {
      if (sawGladiaSdk && appliedPeerStubs === 0) {
        throw new Error(
          "gladia-browser-peer-stubs: @gladiaio/sdk was bundled but no peer stub was applied; check getGladiaBrowserPeer against the SDK's current imports.",
        );
      }
    },
    load(id) {
      if (id === "\0gladia-browser-peer:undici") {
        return "export class Agent {}; export const setGlobalDispatcher = () => {};";
      }
      if (id === "\0gladia-browser-peer:ws") {
        return "export const WebSocket = globalThis.WebSocket;";
      }
      if (id === "\0gladia-browser-peer:fs") {
        return "export const readFileSync = () => { throw new Error('Node file uploads are unavailable in the desktop webview'); };";
      }
      if (id === "\0gladia-browser-peer:path") {
        return "export const basename = () => { throw new Error('Node paths are unavailable in the desktop webview'); };";
      }
      return null;
    },
  };
};

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
      gladiaBrowserPeerStubs(),
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
