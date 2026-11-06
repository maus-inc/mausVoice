import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const fixtures = [];
afterEach(() => {
  fixtures
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const fixture = ({ base, translated, cache, otherTranslations = {} }) => {
  const root = mkdtempSync(path.join(tmpdir(), "maus-i18n-sync-"));
  fixtures.push(root);
  const locales = path.join(root, "src/i18n/locales");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(locales, ".cache"), { recursive: true });
  copyFileSync(
    new URL("./i18n-sync.mjs", import.meta.url),
    path.join(root, "scripts/i18n-sync.mjs"),
  );
  writeFileSync(
    path.join(root, "src/i18n/manifest.json"),
    JSON.stringify({
      defaultLocale: "en",
      supportedLocales: ["en", "fr", ...Object.keys(otherTranslations)],
    }),
  );
  writeFileSync(path.join(locales, "en.json"), JSON.stringify(base));
  writeFileSync(path.join(locales, "fr.json"), JSON.stringify(translated));
  for (const [locale, messages] of Object.entries(otherTranslations))
    writeFileSync(
      path.join(locales, `${locale}.json`),
      JSON.stringify(messages),
    );
  if (cache !== undefined)
    writeFileSync(path.join(locales, ".cache/en.json"), cache);
  const sync = (args = []) => {
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/i18n-sync.mjs"), ...args],
      { stdio: "pipe" },
    );
    return JSON.parse(readFileSync(path.join(locales, "fr.json"), "utf8"));
  };
  sync.write = (locale, messages) =>
    writeFileSync(
      path.join(locales, `${locale}.json`),
      JSON.stringify(messages),
    );
  sync.read = (locale) =>
    JSON.parse(readFileSync(path.join(locales, `${locale}.json`), "utf8"));
  return sync;
};

it("retains a new key already translated alongside the source change", () => {
  const sync = fixture({
    base: { old: "Old", added: "Allowed", missing: "Missing" },
    translated: { old: "Ancien", added: "Autorisé", obsolete: "Obsolète" },
    cache: JSON.stringify({ old: "Old" }),
  });
  expect(sync()).toEqual({
    old: "Ancien",
    added: "Autorisé",
    missing: "Missing",
  });
  expect(sync()).toEqual({
    old: "Ancien",
    added: "Autorisé",
    missing: "Missing",
  });
});

it("still invalidates a translation when its existing source wording changes", () => {
  const sync = fixture({
    base: { changed: "New meaning", stable: "Same" },
    translated: { changed: "Ancien sens", stable: "Identique" },
    cache: JSON.stringify({ changed: "Old meaning", stable: "Same" }),
  });
  expect(sync()).toEqual({ changed: "New meaning", stable: "Identique" });
});

it.each([undefined, "{broken", "null", "[]", '{"same":42}'])(
  "does not destroy translations when the source cache is unavailable/invalid: %s",
  (cache) => {
    expect(
      fixture({
        base: { same: "Same" },
        translated: { same: "Identique" },
        cache,
      })(),
    ).toEqual({ same: "Identique" });
  },
);

it.each([false, true])(
  "tracks source changes per target across partial sync (legacy=%s)",
  (legacy) => {
    const sync = fixture({
      base: { word: "Original" },
      translated: { word: "Original français" },
      otherTranslations: { de: { word: "Ursprünglich" } },
      cache: legacy ? JSON.stringify({ word: "Original" }) : undefined,
    });
    if (!legacy) sync();
    sync.write("en", { word: "New meaning" });
    expect(sync(["--locale=fr"])).toEqual({ word: "New meaning" });
    sync.write("fr", { word: "Nouveau sens" });
    expect(sync()).toEqual({ word: "Nouveau sens" });
    expect(sync.read("de")).toEqual({ word: "New meaning" });
  },
);

it("validates every requested locale before changing any catalog", () => {
  const sync = fixture({
    base: { word: "New" },
    translated: { word: "Ancien" },
    cache: JSON.stringify({ word: "Old" }),
  });
  expect(() => sync(["--locale=fr,unsupported"])).toThrow();
  expect(sync.read("fr")).toEqual({ word: "Ancien" });
});
