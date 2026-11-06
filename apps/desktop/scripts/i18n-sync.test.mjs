import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
    sync.output = execFileSync(
      process.execPath,
      [path.join(root, "scripts/i18n-sync.mjs"), ...args],
      { encoding: "utf8", stdio: "pipe" },
    );
    return JSON.parse(readFileSync(path.join(locales, "fr.json"), "utf8"));
  };
  sync.root = root;
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

it("preserves prototype-shaped message IDs and empty source strings", () => {
  const base = JSON.parse(
    '{"__proto__":"New", "constructor":"", "toString":"Same"}',
  );
  const translated = JSON.parse(
    '{"__proto__":"Traduit", "constructor":"Vide", "toString":"Même", "obsolete":"Old"}',
  );
  const sync = fixture({ base, translated });
  expect(sync()).toEqual(
    JSON.parse(
      '{"__proto__":"Traduit", "constructor":"Vide", "toString":"Même"}',
    ),
  );
  expect(sync.output).toContain("3 existing, 0 added, removed 1");
  expect(sync()).toEqual(
    JSON.parse(
      '{"__proto__":"Traduit", "constructor":"Vide", "toString":"Même"}',
    ),
  );
});

it("rejects traversal-shaped locale identifiers even if they appear in the manifest", () => {
  const sync = fixture({
    base: { word: "New" },
    translated: { word: "Ancien" },
    cache: JSON.stringify({ word: "Old" }),
  });
  writeFileSync(
    path.join(sync.root, "src/i18n/manifest.json"),
    JSON.stringify({
      defaultLocale: "en",
      supportedLocales: ["en", "fr", "../escaped"],
    }),
  );
  writeFileSync(
    path.join(sync.root, "src/i18n/escaped.json"),
    JSON.stringify({ word: "Outside" }),
  );
  expect(() => sync()).toThrow();
  expect(sync.read("fr")).toEqual({ word: "Ancien" });
  expect(
    JSON.parse(
      readFileSync(path.join(sync.root, "src/i18n/escaped.json"), "utf8"),
    ),
  ).toEqual({ word: "Outside" });
});

it.skipIf(process.platform === "win32")(
  "refuses a symlinked target before changing any locale",
  () => {
    const sync = fixture({
      base: { word: "New" },
      translated: { word: "Ancien" },
      otherTranslations: { de: { word: "Alt" } },
      cache: JSON.stringify({ word: "Old" }),
    });
    const outside = path.join(sync.root, "outside.json");
    writeFileSync(outside, JSON.stringify({ word: "Outside" }));
    const target = path.join(sync.root, "src/i18n/locales/de.json");
    rmSync(target);
    symlinkSync(outside, target);
    expect(() => sync()).toThrow();
    expect(sync.read("fr")).toEqual({ word: "Ancien" });
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({
      word: "Outside",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "rejects a linked cache before mutating translations",
  () => {
    const sync = fixture({
      base: { word: "New" },
      translated: { word: "Ancien" },
      cache: JSON.stringify({ word: "Old" }),
    });
    const locales = path.join(sync.root, "src/i18n/locales");
    const outside = path.join(sync.root, "outside-cache");
    mkdirSync(outside);
    rmSync(path.join(locales, ".cache"), { recursive: true });
    symlinkSync(outside, path.join(locales, ".cache"), "dir");
    expect(() => sync()).toThrow();
    expect(sync.read("fr")).toEqual({ word: "Ancien" });
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a symlinked source catalog",
  () => {
    const sync = fixture({
      base: { word: "New" },
      translated: { word: "Ancien" },
    });
    const source = path.join(sync.root, "src/i18n/locales/en.json");
    const outside = path.join(sync.root, "outside-source.json");
    writeFileSync(outside, JSON.stringify({ word: "Other" }));
    rmSync(source);
    symlinkSync(outside, source);
    expect(() => sync()).toThrow();
    expect(sync.read("fr")).toEqual({ word: "Ancien" });
  },
);
