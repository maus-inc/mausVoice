import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function computeChangedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => {
    const beforeValue = before[key];
    const afterValue = after[key];
    const beforeSerialized =
      beforeValue === undefined ? undefined : JSON.stringify(beforeValue);
    const afterSerialized =
      afterValue === undefined ? undefined : JSON.stringify(afterValue);
    return beforeSerialized !== afterSerialized;
  });
}

export async function pruneLocaleFile(localePath, keys) {
  const localeData = await readJson(localePath);
  let updated = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(localeData, key)) {
      delete localeData[key];
      updated = true;
    }
  }
  if (updated) {
    await writeJson(localePath, localeData);
  }
  return updated;
}

/** Prune outdated translations across locale JSON files, excluding English. */
export async function pruneLocaleDirectory(localesDir, changedKeys) {
  const localeFiles = (await readdir(localesDir)).filter(
    (fileName) => fileName.endsWith(".json") && fileName !== "en.json",
  );
  const prunedLocales = [];
  for (const fileName of localeFiles) {
    if (await pruneLocaleFile(join(localesDir, fileName), changedKeys)) {
      prunedLocales.push(fileName);
    }
  }
  return prunedLocales;
}
