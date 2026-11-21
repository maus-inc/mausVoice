import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHROMIUM_LAUNCH_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-zygote",
  "--single-process",
  "--disable-dev-shm-usage",
];

export function createReportDirectory() {
  const output =
    process.env.OUT_DIR ||
    fileURLToPath(new URL("../../reports/ui-verify/", import.meta.url));
  mkdirSync(output, { recursive: true });
  return output;
}
