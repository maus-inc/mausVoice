import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  THEME_COLOR_SCHEME_SELECTOR,
  THEME_MODE_STORAGE_KEY,
  THEME_PROVIDER_CONFIG,
  theme,
} from "./theme";

const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const bootstrapScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

const runBootstrap = ({
  mode,
  legacyMode,
  systemDark,
}: {
  mode?: string;
  legacyMode?: string;
  systemDark: boolean;
}) => {
  const storage = new Map<string, string>();
  if (mode) storage.set(THEME_MODE_STORAGE_KEY, mode);
  if (legacyMode) storage.set("mui-mode", legacyMode);
  let appliedScheme: string | undefined;

  runInNewContext(bootstrapScript ?? "", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window: {
      matchMedia: () => ({ matches: systemDark }),
    },
    document: {
      documentElement: {
        setAttribute: (_attribute: string, value: string) => {
          appliedScheme = value;
        },
      },
    },
  });

  return { appliedScheme, storage };
};

describe("theme mode configuration", () => {
  it("uses a DOM selector so manual mode changes can override the OS scheme", () => {
    expect(theme.colorSchemeSelector).toBe(THEME_COLOR_SCHEME_SELECTOR);
    expect(theme.colorSchemeSelector).not.toBe("media");
    expect(theme.getColorSchemeSelector("light")).toBe(
      `[${THEME_COLOR_SCHEME_SELECTOR}="light"] &`,
    );
    expect(theme.getColorSchemeSelector("dark")).toBe(
      `[${THEME_COLOR_SCHEME_SELECTOR}="dark"] &`,
    );
  });

  it("persists the selected mode under the key read during bootstrap", () => {
    expect(THEME_PROVIDER_CONFIG).toEqual({
      defaultMode: "system",
      modeStorageKey: THEME_MODE_STORAGE_KEY,
    });
    expect(indexHtml).toContain(
      `localStorage.getItem("${THEME_MODE_STORAGE_KEY}")`,
    );
  });

  it("applies the resolved scheme before the app mounts", () => {
    expect(indexHtml).toMatch(
      new RegExp(
        `document\\.documentElement\\.setAttribute\\(\\s*"${THEME_COLOR_SCHEME_SELECTOR}"`,
      ),
    );
    expect(indexHtml).toContain(
      `html[${THEME_COLOR_SCHEME_SELECTOR}="light"] body`,
    );
    expect(indexHtml).toContain(
      `html[${THEME_COLOR_SCHEME_SELECTOR}="dark"] body`,
    );

    expect(
      runBootstrap({ mode: "light", systemDark: true }).appliedScheme,
    ).toBe("light");
    expect(
      runBootstrap({ mode: "dark", systemDark: false }).appliedScheme,
    ).toBe("dark");
    expect(
      runBootstrap({ mode: "system", systemDark: false }).appliedScheme,
    ).toBe("light");
  });

  it("migrates the latest mode written by the previous broken provider config", () => {
    const { appliedScheme, storage } = runBootstrap({
      mode: "dark",
      legacyMode: "light",
      systemDark: true,
    });

    expect(appliedScheme).toBe("light");
    expect(storage.get(THEME_MODE_STORAGE_KEY)).toBe("light");
    expect(storage.has("mui-mode")).toBe(false);
  });
});
