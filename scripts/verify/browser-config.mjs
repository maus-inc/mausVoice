import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROMIUM_LAUNCH_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-zygote",
  "--single-process",
  "--disable-dev-shm-usage",
];

export function createReportDirectory() {
  const output = process.env.OUT_DIR || join(tmpdir(), "mausvoice-ui-verify");
  mkdirSync(output, { recursive: true });
  return output;
}
