import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Merge the app's own Vite config so tests resolve exactly what the app and
// tsc resolve. Without this the `@desktop/*` alias is missing under vitest
// (vitest.config.ts takes precedence over vite.config.ts) and any test that
// reaches a demo component dies on "Failed to resolve import".
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  }),
);
