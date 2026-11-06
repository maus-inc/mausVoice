import { execSync } from "child_process";
import {
  readJson,
  computeChangedKeys,
  pruneLocaleDirectory,
} from "./i18n-prune.mjs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const localesDir = path.join(desktopRoot, "src", "i18n", "locales");
const englishLocalePath = path.join(localesDir, "en.json");

const formatjsCommand =
  'npx --no-install formatjs extract "src/**/*.{ts,tsx}" --ignore "src/**/*.d.ts" --out-file src/i18n/locales/en.json --format ./scripts/formatjs-formatter.mjs --id-interpolation-pattern "[sha1:contenthash:base64:6]"';

async function main() {
  const beforeSnapshot = await readJson(englishLocalePath);
  execSync(formatjsCommand, {
    cwd: desktopRoot,
    stdio: "inherit",
  });
  const afterSnapshot = await readJson(englishLocalePath);
  const changedKeys = computeChangedKeys(beforeSnapshot, afterSnapshot);
  if (changedKeys.length === 0) {
    console.log("No changes detected in en.json; skipping locale pruning.");
    return;
  }
  console.log(
    `Detected ${changedKeys.length} changed en.json entr${changedKeys.length === 1 ? "y" : "ies"}. Removing them from other locales.`,
  );

  const prunedLocales = await pruneLocaleDirectory(localesDir, changedKeys);

  if (prunedLocales.length > 0) {
    console.log(
      `Pruned ${changedKeys.length} key(s) from ${prunedLocales.join(", ")}.`,
    );
  } else {
    console.log(
      "Other locale files already matched the English locale after extraction.",
    );
  }
}

main().catch((error) => {
  console.error("Failed to run i18n extraction with pruning:", error);
  process.exitCode = 1;
});
