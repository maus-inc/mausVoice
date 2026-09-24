#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../src/i18n/manifest.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const localesDir = path.join(projectRoot, "src/i18n/locales");

const defaultLocale = manifest.defaultLocale;
const supportedLocales = manifest.supportedLocales;

const args = process.argv.slice(2);
const sourceLocaleArg = args.find((arg) => arg.startsWith("--source-locale="));
const sourceLocale = sourceLocaleArg
  ? sourceLocaleArg.replace("--source-locale=", "").trim()
  : defaultLocale;

if (!supportedLocales.includes(sourceLocale)) {
  console.error(
    `[i18n] Source locale "${sourceLocale}" is not listed in src/i18n/manifest.json.`,
  );
  process.exit(1);
}

const baseLocalePath = path.join(localesDir, `${sourceLocale}.json`);

if (!fs.existsSync(baseLocalePath)) {
  console.error(
    `[i18n] Base locale file ${baseLocalePath} does not exist. Run the extract command first.`,
  );
  process.exit(1);
}

const baseMessages = JSON.parse(fs.readFileSync(baseLocalePath, "utf8"));
// Deterministic code-unit order: `localeCompare()` without an explicit locale
// follows the host's ICU collation, so identical sources could produce
// differently ordered catalogs on machines with different system locales and
// trip the CI "no diff after sync" check.
const compareKeys = (a, b) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
const sortedKeys = Object.keys(baseMessages).sort(compareKeys);

const cacheDir = path.join(localesDir, ".cache");
const cacheFilePath = path.join(cacheDir, `${sourceLocale}.json`);

const readCachedBase = (file) => {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string")
    ) {
      throw new TypeError("Expected a cached string-message catalog");
    }
    return parsed;
  } catch (error) {
    console.warn(
      `[i18n] Unable to read cached base for "${sourceLocale}": ${error.message}`,
    );
    // Missing history is not evidence that every existing translation is stale.
    return {};
  }
};

const changedKeysFor = (locale) => {
  const targetCache = path.join(cacheDir, `${sourceLocale}--${locale}.json`);
  // Migrate the old shared cache lazily. Each target must thereafter track its
  // own baseline: a partial --locale sync cannot acknowledge changes for others.
  const previous = readCachedBase(
    fs.existsSync(targetCache) ? targetCache : cacheFilePath,
  );
  return new Set(
    sortedKeys.filter(
      (key) =>
        Object.hasOwn(previous, key) && previous[key] !== baseMessages[key],
    ),
  );
};

const localeArg = args.find((arg) => arg.startsWith("--locale="));

let localesToSync = supportedLocales.filter(
  (locale) => locale !== sourceLocale,
);

if (localeArg) {
  localesToSync = localeArg
    .replace("--locale=", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

localesToSync = localesToSync.filter((locale) => locale !== sourceLocale);

if (localesToSync.length === 0) {
  console.log("[i18n] No locales selected for syncing.");
  process.exit(0);
}

const ensureLocale = (locale) => {
  if (!supportedLocales.includes(locale)) {
    throw new Error(
      `[i18n] Locale "${locale}" is not listed in src/i18n/manifest.json.`,
    );
  }
};

const writeLocaleFile = (locale) => {
  ensureLocale(locale);
  const targetFile = path.join(localesDir, `${locale}.json`);
  let existingMessages = {};

  if (fs.existsSync(targetFile)) {
    existingMessages = JSON.parse(fs.readFileSync(targetFile, "utf8"));
  }

  const changedKeys = changedKeysFor(locale);
  const nextMessages = {};
  let added = 0;
  let retained = 0;
  let reset = 0;

  for (const key of sortedKeys) {
    const hasExisting = Object.hasOwn(existingMessages, key);
    const shouldReset = changedKeys.has(key);

    if (hasExisting && !shouldReset) {
      nextMessages[key] = existingMessages[key];
      retained += 1;
    } else {
      nextMessages[key] = baseMessages[key];

      if (hasExisting && shouldReset) {
        reset += 1;
      } else if (!hasExisting) {
        added += 1;
      }
    }
  }

  const removedKeys = Object.keys(existingMessages).filter(
    (key) => !baseMessages[key],
  );

  fs.writeFileSync(targetFile, `${JSON.stringify(nextMessages, null, 2)}\n`);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `${sourceLocale}--${locale}.json`),
    `${JSON.stringify(baseMessages, null, 2)}\n`,
  );

  const removedLabel =
    removedKeys.length > 0 ? `, removed ${removedKeys.length}` : "";
  console.log(
    `[i18n] Synced ${locale}: ${retained} existing, ${added} added${
      reset > 0 ? `, reset ${reset}` : ""
    }${removedLabel}.`,
  );
};

// Validate the whole selection before mutating even the first target.
localesToSync.forEach(ensureLocale);
localesToSync.forEach(writeLocaleFile);

// Preserve a usable migration baseline for targets not yet synced individually.
const syncedAll = supportedLocales.every(
  (locale) => locale === sourceLocale || localesToSync.includes(locale),
);
if (syncedAll) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFilePath, `${JSON.stringify(baseMessages, null, 2)}\n`);
}
