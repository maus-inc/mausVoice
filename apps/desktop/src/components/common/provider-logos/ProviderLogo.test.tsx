// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../../theme";
import { hasProviderLogo, ProviderLogo } from "./ProviderLogo";
import { PROVIDER_LOGOS } from "./ProviderLogos";

ensureUiHarness();

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "..", "..", "assets", "provider-logos");
const generatorPath = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "generate-provider-logos.mjs",
);

const assetFiles = readdirSync(assetsDir).filter((name) =>
  name.endsWith(".svg"),
);

const readAsset = (file: string) => readFileSync(join(assetsDir, file), "utf8");

const shapesOf = (svg: string) =>
  [...svg.matchAll(/<(?:path|rect|circle|ellipse)\b[^>]*>/g)].map(
    (match) => match[0],
  );

const luminance = (hex: string) => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/** The app's own surface ladder, from `styles/palette.ts`. */
const CREAM = "#FDFBF8";
const ONYX = "#161617";

/**
 * The generated module is committed so both bundles can import it, which means
 * it can drift from the artwork. This regenerates it in memory and compares, so
 * an asset edited without re-running the generator fails here instead of
 * shipping a mark that no longer matches its file.
 */
describe("ProviderLogos generated module", () => {
  it("matches the vendored artwork", async () => {
    // `writeModule({ check: true })` is the same comparison the
    // `gen:provider-logos --check` script makes, and it runs the emitter's own
    // formatting, so this never disagrees with the generator.
    const { writeModule } = (await import(generatorPath)) as {
      writeModule: (options: { check: boolean }) => Promise<{
        changed: boolean;
      }>;
    };
    const { changed } = await writeModule({ check: true });
    expect(changed).toBe(false);
  });

  it("exports one component per asset file", () => {
    const ids = assetFiles.map((file) => file.replace(/\.svg$/, ""));
    expect(Object.keys(PROVIDER_LOGOS).sort()).toEqual(ids.sort());
  });
});

describe("provider logo artwork", () => {
  it("has no opaque background behind any mark", () => {
    // Gladia ships its mark on a navy tile; the tile is background, not mark,
    // and it is the one file that had to be rewritten to drop it. A `<rect>`
    // filling the viewBox is how that regression would come back.
    for (const file of assetFiles) {
      const svg = readAsset(file);
      const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
      expect(viewBox, `${file} has a viewBox`).toBeTruthy();
      for (const rect of svg.matchAll(/<rect\b[^>]*>/g)) {
        expect(rect[0], `${file} draws a background rect`).not.toMatch(
          /width="100%"|fill="(?!none)/,
        );
      }
    }
  });

  it("is transparent and self-contained", () => {
    for (const file of assetFiles) {
      const svg = readAsset(file);
      expect(svg, file).toMatch(/^<svg /);
      expect(svg, file).not.toMatch(/<style|<script|<image|<title/);
      // Nothing may point outside the file: the app's CSP would block it.
      expect(svg, file).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    }
  });

  it("namespaces every paint-server id by provider", () => {
    for (const file of assetFiles) {
      const provider = file.replace(/\.svg$/, "").replace(/-mono$|-dark$/, "");
      for (const [, id] of readAsset(file).matchAll(/\sid="([^"]+)"/g)) {
        expect(id, `${file} id ${id}`).toContain(provider);
      }
    }
  });

  it("keeps every colour mark legible on the surface it is drawn on", () => {
    // Colour marks are used as published, so the only defence against one
    // sinking into a surface is measuring it. Every mark here clears the 3:1
    // floor for a non-text graphic on the surface it is drawn on: both surfaces
    // where one file serves both, and only its own where a per-scheme pair
    // exists (see `PAIRED` in the component and the asset README).
    const drawnOnDark = (file: string) =>
      file.endsWith("-dark.svg") || file.endsWith("-mono.svg");
    const colourMarks = assetFiles.filter(
      (file) => !/\sfill="currentColor"/.test(readAsset(file)),
    );
    expect(colourMarks.length).toBeGreaterThan(0);
    for (const file of colourMarks) {
      const fills = [...readAsset(file).matchAll(/fill="(#[0-9a-fA-F]{6})"/g)];
      expect(fills.length, `${file} declares a brand fill`).toBeGreaterThan(0);
      for (const [, hex] of fills) {
        // A mark without a per-scheme sibling is drawn on both surfaces, so it
        // has to survive both. `gladia.svg` and `openrouter.svg` do have one,
        // so they are measured on cream alone.
        const surfaces = drawnOnDark(file) ? [ONYX] : [CREAM];
        for (const surface of surfaces) {
          expect(
            contrast(hex, surface),
            `${file} ${hex} on ${surface}`,
          ).toBeGreaterThan(2.9);
        }
      }
    }
  });

  it("still draws ink marks, rather than dropping their paths", () => {
    // An ink mark is a single path with no fill of its own; the component's
    // root `fill="currentColor"` is what colours it.
    for (const file of assetFiles) {
      const svg = readAsset(file);
      if (!/\sfill="currentColor"/.test(svg)) continue;
      expect(shapesOf(svg).length, `${file} has a shape`).toBeGreaterThan(0);
      for (const shape of shapesOf(svg)) {
        expect(shape, `${file} does not bake an ink into a path`).not.toMatch(
          /\sfill="(?!none)/,
        );
      }
    }
  });
});

describe("ProviderLogo", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setMatchMedia(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (node: React.ReactElement) => {
    act(() => {
      root.render(createElement(ThemeProvider, { theme }, node));
    });
  };

  it("draws the provider's mark at the requested size", () => {
    render(createElement(ProviderLogo, { provider: "groq", size: 20 }));
    const box = container.querySelector("span");
    expect(box).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
    const styles = getComputedStyle(box as HTMLElement);
    expect(styles.width).toBe("20px");
    expect(styles.height).toBe("20px");
  });

  it("is decorative unless it is given a name", () => {
    render(createElement(ProviderLogo, { provider: "openai" }));
    const box = container.querySelector("span") as HTMLElement;
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.hasAttribute("aria-label")).toBe(false);

    render(
      createElement(ProviderLogo, { provider: "openai", label: "OpenAI" }),
    );
    const labelled = container.querySelector("span") as HTMLElement;
    expect(labelled.getAttribute("role")).toBe("img");
    expect(labelled.getAttribute("aria-label")).toBe("OpenAI");
    expect(labelled.hasAttribute("aria-hidden")).toBe(false);
  });

  it("renders nothing for a provider with no published mark", () => {
    for (const provider of [
      "aldea",
      "speaches",
      "openai-compatible",
    ] as const) {
      expect(hasProviderLogo(provider)).toBe(false);
      render(createElement(ProviderLogo, { provider }));
      expect(container.innerHTML).toBe("");
    }
  });

  it("swaps to the white sibling on the dark surface", () => {
    // Gladia's mark is dark navy, which the onyx surface swallows. Only that
    // one provider carries a per-scheme pair; every other mark is complete on
    // both surfaces.
    render(createElement(ProviderLogo, { provider: "gladia" }));
    const light = container.querySelector("path")?.getAttribute("fill");
    expect(light).toBe("#141A2A");
  });

  it("covers every provider the app can store", () => {
    // Guards the mapping against a provider being added to API_KEY_PROVIDERS
    // and silently rendering no mark at all.
    const providers = readFileSync(
      join(
        here,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "packages",
        "types",
        "src",
        "apiKey.types.ts",
      ),
      "utf8",
    );
    const listed = [...providers.matchAll(/^\s{2}"([a-z-]+)",$/gm)].map(
      (match) => match[1],
    );
    expect(listed.length).toBeGreaterThan(10);
    const missing = listed.filter(
      (provider) => !hasProviderLogo(provider as never),
    );
    // These four have no verifiable artwork; the list is pinned so adding a
    // provider without artwork is a deliberate edit to this test.
    expect(missing.sort()).toEqual(
      ["aldea", "openai-compatible", "speaches"].sort(),
    );
  });
});
