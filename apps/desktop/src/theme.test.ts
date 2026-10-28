import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  THEME_COLOR_SCHEME_SELECTOR,
  THEME_MODE_STORAGE_KEY,
  THEME_PROVIDER_CONFIG,
  guardedThemeStorageManager,
  theme,
} from "./theme";

const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const bootstrapScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

const runBootstrap = ({
  storedMode,
  fallbackMode,
  systemDark,
}: {
  storedMode?: string;
  fallbackMode?: string;
  systemDark: boolean;
}) => {
  const storage = new Map<string, string>();
  const dataset: Record<string, string> = {};
  if (storedMode) storage.set(THEME_MODE_STORAGE_KEY, storedMode);
  if (fallbackMode) storage.set("mode", fallbackMode);

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
      documentElement: { dataset },
    },
  });

  return { appliedScheme: dataset.muiColorScheme, storage };
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
      storageManager: guardedThemeStorageManager,
      disableTransitionOnChange: true,
    });
    expect(indexHtml).toContain(
      `localStorage.getItem("${THEME_MODE_STORAGE_KEY}")`,
    );
  });

  it("applies the resolved scheme before the app mounts", () => {
    expect(indexHtml).toContain(
      "document.documentElement.dataset.muiColorScheme = resolved",
    );
    expect(indexHtml).toContain(
      `html[${THEME_COLOR_SCHEME_SELECTOR}="light"] body`,
    );
    expect(indexHtml).toContain(
      `html[${THEME_COLOR_SCHEME_SELECTOR}="dark"] body`,
    );

    expect(
      runBootstrap({ storedMode: "light", systemDark: true }).appliedScheme,
    ).toBe("light");
    expect(
      runBootstrap({ storedMode: "dark", systemDark: false }).appliedScheme,
    ).toBe("dark");
    expect(
      runBootstrap({ storedMode: "system", systemDark: false }).appliedScheme,
    ).toBe("light");
  });

  it("reads the legacy fallback without writing it back at startup", () => {
    const { appliedScheme, storage } = runBootstrap({
      fallbackMode: "light",
      systemDark: true,
    });

    expect(appliedScheme).toBe("light");
    expect(storage.has(THEME_MODE_STORAGE_KEY)).toBe(false);
    expect(storage.get("mode")).toBe("light");
  });

  it("reads an existing legacy value through MUI without migrating it", () => {
    const values = new Map([["mode", "light"]]);
    const storageWindow = {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;

    const manager = guardedThemeStorageManager({
      key: THEME_MODE_STORAGE_KEY,
      storageWindow,
    });

    expect(manager.get("system")).toBe("light");
    expect(values.has(THEME_MODE_STORAGE_KEY)).toBe(false);
  });

  it("keeps the current MUI mode when both storage keys exist", () => {
    const { appliedScheme, storage } = runBootstrap({
      storedMode: "dark",
      fallbackMode: "light",
      systemDark: false,
    });

    expect(appliedScheme).toBe("dark");
    expect(storage.get(THEME_MODE_STORAGE_KEY)).toBe("dark");
  });

  it("lets selected lucide icons inherit list item color in both schemes", () => {
    const themeSource = readFileSync(
      new URL("./theme.ts", import.meta.url),
      "utf8",
    );
    const listItemButtonBlock = themeSource.slice(
      themeSource.indexOf("MuiListItemButton:"),
      themeSource.indexOf("MuiListItemIcon:"),
    );
    const darkStyleStart = listItemButtonBlock.indexOf('applyStyles("dark"');
    const lightStyleBlock = listItemButtonBlock.slice(0, darkStyleStart);
    const darkStyleBlock = listItemButtonBlock.slice(darkStyleStart);
    const lucideInheritanceRule = /"& svg\.lucide": \{\s*color: "inherit"/g;

    expect(darkStyleBlock).toContain('applyStyles("dark"');
    expect(lightStyleBlock.match(lucideInheritanceRule) ?? []).toHaveLength(1);
    expect(darkStyleBlock.match(lucideInheritanceRule) ?? []).toHaveLength(1);
  });
});

describe("palette variable consumers", () => {
  it.each([
    "./components/common/CopyableCommand.tsx",
    "./components/home/GettingStartedList.tsx",
    "./styles/dotmatrix.css",
  ])("references variables emitted by the theme in %s", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const styles = JSON.stringify(theme.generateStyleSheets());
    for (const [, variable] of source.matchAll(
      /var\((--(?:app|mui)-palette-[\w-]+)/g,
    )) {
      expect(styles, variable).toContain(`"${variable}":`);
    }
  });
});
