import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const desktopSrc = path.resolve(rootDir, "../desktop/src");

/**
 * The `/@fs/` URL that serves an absolute filesystem path.
 *
 * Mirrors what Vite itself does (`/@fs/` plus the path with its leading slash
 * removed, separators normalised), rather than concatenating `"/@fs" + dir`.
 * That concatenation is wrong in two ways: it yields a double slash on POSIX and
 * `/@fsC:\\...` on Windows, where the drive letter follows `@fs` directly. The
 * Windows form is not an fs URL at all, so the proxy 404s before the request
 * reaches the plugin that was supposed to rewrite it.
 */
const fsUrlFor = (absolutePath: string): string =>
  "/@fs/" + absolutePath.replace(/\\/g, "/").replace(/^\/+/, "");

// The preview renders REAL desktop components (`@desktop/*`), and those write
// their user-facing strings as `FormattedMessage`/`useIntl` literals with no
// `id`. The desktop app compiles them with `babel-plugin-formatjs`, which turns
// every literal into an id derived from its text. The preview had no such
// transform, so any real component with visible copy threw
// "An `id` must be provided to format a message" and rendered nothing — which
// is why no demo had ever mounted one.
//
// This mirrors the desktop's override id function (same module, same
// derivation) so a preview string and an app string resolve to the same id.
const formatjsOverrideIdFn = (
  await import("../desktop/scripts/formatjs-id.mjs")
).formatjsOverrideIdFn as (
  id: string | undefined,
  defaultMessage: string | undefined,
  description: string | undefined,
  filePath: string | undefined,
) => string | undefined;

// The preview site imports the REAL desktop components/theme directly.
// Those files live outside this app's root, so:
// - `@desktop/*` aliases into apps/desktop/src,
// - fs.allow permits serving them in dev,
// - dedupe guarantees one React/MUI/emotion instance even though the
//   imported files sit under apps/desktop (avoids dual-copy hook breaks).
export default defineConfig({
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
  ],
  resolve: {
    alias: {
      "@desktop": desktopSrc,
      "@preview": path.resolve(rootDir, "src"),
    },
    dedupe: [
      "react",
      "react-dom",
      "react-intl",
      "react-router-dom",
      "@mui/material",
      "@mui/system",
      "@mui/icons-material",
      "@emotion/react",
      "@emotion/styled",
      "framer-motion",
      "morphicons",
      "lucide",
    ],
  },
  server: {
    host: "0.0.0.0",
    port: 5193,
    // Refuse to start rather than move to the next free port.
    //
    // The proxy below targets this server's own port, and the verify scripts and
    // harness URLs name it explicitly. A silent move to 5194 left the proxy
    // pointing at whatever was on 5193 instead -- another process, or this same
    // config's `preview` block -- so every `@desktop/*` import failed with a
    // confusing error rather than "that port is taken". Failing loudly here is
    // what keeps the failure legible.
    strictPort: true,
    // `host: "0.0.0.0"` already exposes this dev server to the network, and
    // `allowedHosts: true` additionally switches OFF Vite's Host-header check. The pair is a
    // DNS-rebinding hole: any web page the developer visits could resolve its own hostname to
    // this server and read the app, which serves the real desktop source through `fs.allow`.
    //
    // So the hosts are named instead. Loopback keeps working with no setup; serving anyone
    // else on the LAN is now an explicit opt-in.
    //
    //   PREVIEW_ALLOWED_HOSTS=preview-host.local,192.168.1.20 pnpm --filter @maus-inc/preview dev
    //
    // A leading dot allows a whole domain (`example.local` matches `a.example.local`); a
    // literal IP must be listed exactly, because Vite compares the Host header verbatim.
    //
    // The variable ADDS to the loopback set rather than replacing it. Replacing it meant that
    // naming one LAN host silently stopped the dev server answering on `localhost`, which is
    // the opposite of what "serving anyone else on the LAN is an explicit opt-in" implies.
    //
    // The two IP literals are belt-and-braces: Vite short-circuits IP hosts before consulting
    // this list, so `[::1]` in particular never has to match. They are kept because that
    // short-circuit is Vite's internal behaviour rather than a documented contract.
    allowedHosts: [
      ".localhost",
      "127.0.0.1",
      "[::1]",
      ...(process.env.PREVIEW_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    ],
    fs: {
      // `rootDir` and `desktopSrc` are the only two roots the preview reads: specs and
      // components live under the first, and `@desktop/*` aliases into the second. Listing
      // their shared parent admitted every other workspace package under `apps/` --
      // `apps/firebase/**`, `apps/docs/**` -- which a demo dev server has no reason to serve.
      allow: [rootDir, desktopSrc],
    },
    proxy: {
      // The probe scripts import from the desktop package, so the module graph is
      // rewritten to fetch those files through this server.
      "/@desktop": {
        target: "http://127.0.0.1:5193",
        // `@fs` takes a URL path, so the separator has to be a forward slash.
        // `desktopSrc` is an absolute filesystem path, which on Windows starts
        // with a drive letter and uses backslashes: concatenated raw it forms
        // `/@fsC:\...`, which is not a Vite fs URL at all and fails before the
        // request leaves the server.
        rewrite: (p) => p.replace(/^\/@desktop/, fsUrlFor(desktopSrc)),
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5194,
  },
  optimizeDeps: {
    // The harness renders desktop components through React.lazy, so a stale
    // prebundle shows the old dialog after an edit and the screenshots lie.
    exclude: ["@desktop/components/settings/MicrophoneDialog"],
  },
});
