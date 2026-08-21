import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development", "import", "module", "browser", "default"],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "test/integration/**/*.test.ts",
      "test/evals/**/*.test.ts",
    ],
    setupFiles: ["./test/helpers/setup.ts"],
  },
});
