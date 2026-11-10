import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createMessageId } from "../desktop/scripts/formatjs-id.mjs";
import {
  hasAuthoritativeId,
  rewriteDefaultMessages,
  shouldTransform,
} from "./src/formatjs-ids";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Gives `formatMessage({ defaultMessage })` the id that the formatjs babel
 * plugin would have injected.
 *
 * The desktop components call `intl.formatMessage` with a bare defaultMessage,
 * and react-intl throws without an id. The real app builds through babel, which
 * rewrites those descriptors; the preview builds through Vite, which does not.
 * So the id is derived here the way the plugin derives it, but only for files
 * the verification harness reaches. Without this the harness cannot render the
 * real dialog and would have to fork it, which would verify the fork.
 */
const formatJsIds = {
  name: "formatjs-ids-for-harness",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!shouldTransform(id)) return null;
    if (!code.includes("defaultMessage")) return null;
    // Already rewritten; a second pass would inject a second id and throw.
    if (hasAuthoritativeId(code)) return null;

    // The repository derives ids with `createMessageId`, which slugs the
    // default message, and `apps/desktop/src/i18n/message-id-contract.test.ts`
    // holds every component to it. A hash would produce an id that renders the
    // right text through `defaultMessage` while silently ignoring the real
    // translations, which is worse than no id at all.
    const rewritten = rewriteDefaultMessages(code, (literal) =>
      createMessageId(JSON.parse(literal) as string),
    );
    return rewritten === code ? null : rewritten;
  },
};

const desktopSrc = path.resolve(rootDir, "../desktop/src");

// The preview site imports the REAL desktop components/theme directly.
// Those files live outside this app's root, so:
// - `@desktop/*` aliases into apps/desktop/src,
// - fs.allow permits serving them in dev,
// - dedupe guarantees one React/MUI/emotion instance even though the
//   imported files sit under apps/desktop (avoids dual-copy hook breaks).
export default defineConfig({
  plugins: [react(), formatJsIds],
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
        rewrite: (p) => p.replace(/^\/@desktop/, "/@fs" + desktopSrc),
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
