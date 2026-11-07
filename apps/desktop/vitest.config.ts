import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development", "import", "module", "browser", "default"],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
      "test/integration/**/*.test.ts",
      "test/evals/**/*.test.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      "scripts/run-tauri-dev.test.mjs",
      "scripts/run-tauri-with-sidecars.test.mjs",
    ],
    setupFiles: ["./test/helpers/setup.ts"],
  },
});
