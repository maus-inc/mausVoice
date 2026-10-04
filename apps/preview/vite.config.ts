import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const desktopSrc = path.resolve(rootDir, "../desktop/src");

// The preview site imports the REAL desktop components/theme directly.
// Those files live outside this app's root, so:
// - `@desktop/*` aliases into apps/desktop/src,
// - fs.allow permits serving them in dev,
// - dedupe guarantees one React/MUI/emotion instance even though the
//   imported files sit under apps/desktop (avoids dual-copy hook breaks).
export default defineConfig({
  plugins: [react()],
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
    allowedHosts: process.env.PREVIEW_ALLOWED_HOSTS
      ? process.env.PREVIEW_ALLOWED_HOSTS.split(",")
          .map((host) => host.trim())
          .filter(Boolean)
      : [".localhost", "127.0.0.1", "[::1]"],
    fs: {
      // `rootDir` and `desktopSrc` are the only two roots the preview reads: specs and
      // components live under the first, and `@desktop/*` aliases into the second. Listing
      // their shared parent admitted every other workspace package under `apps/` --
      // `apps/firebase/**`, `apps/docs/**` -- which a demo dev server has no reason to serve.
      allow: [rootDir, desktopSrc],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5194,
  },
});
