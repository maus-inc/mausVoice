import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";

/**
 * Localization completeness contract: a message that is copied verbatim into
 * every non-English catalog has silently shipped untranslated UI. Model names
 * with sizes, brand fragments, and identifiers are expected to stay identical
 * and are allow-listed; anything else must be flagged here (translate it or
 * consciously allow-list it).
 */
const UNIVERSAL_SAFE = [
  // Model catalogs: brand + version + size tuples never translate. Placeholder
  // sentences (e.g. "Version {version} is available.") MUST still be
  // translated, so ICU placeholders are not an exemption.
  /^(SenseVoice|NVIDIA|Whisper)\b/,
];

type Messages = Record<string, string>;

const loadLocales = (): Record<string, Messages> => {
  const locales: Record<string, Messages> = {};
  for (const locale of manifest.supportedLocales as string[]) {
    locales[locale] = JSON.parse(
      readFileSync(
        new URL(`./locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
  }
  return locales;
};

describe("i18n catalogs", () => {
  it("manifest and on-disk locale files agree", () => {
    const onDisk = readdirSync(new URL("./locales/", import.meta.url))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""));
    expect([...onDisk].sort()).toEqual(
      [...(manifest.supportedLocales as string[])].sort(),
    );
  });

  it("flags messages still English in every translated locale", () => {
    const locales = loadLocales();
    const keyedEnglish = locales[manifest.defaultLocale]!;
    const translatedCodes = (manifest.supportedLocales as string[]).filter(
      (code) => code !== manifest.defaultLocale,
    );

    const untranslatedEverywhere: string[] = [];
    for (const [key, message] of Object.entries(keyedEnglish)) {
      if (UNIVERSAL_SAFE.some((re) => re.test(message))) continue;
      const allIdentical = translatedCodes.every(
        (code) => locales[code]?.[key] === message,
      );
      // A one-word label ("Notes", "Bullets") may legitimately coincide with
      // its translation, but a sentence never does.
      if (allIdentical && message.trim().split(/\s+/).length > 2) {
        untranslatedEverywhere.push(key);
      }
    }

    expect(
      untranslatedEverywhere,
      `These keys are untranslated in ALL locales (translate them or extend UNIVERSAL_SAFE):\n${untranslatedEverywhere.join("\n")}`,
    ).toEqual([]);
  });
});
