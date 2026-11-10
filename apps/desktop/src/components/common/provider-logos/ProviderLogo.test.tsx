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
  // WCAG relative luminance, per channel: sRGB decode, then linearise.
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
};

const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

/** The app's own surface ladder, from `styles/palette.ts`. */
const CREAM = "#FDFBF8";
const ONYX = "#161617";

/** WCAG 2.1 SC 1.4.11: the floor for a graphic that carries meaning. */
const MIN_GRAPHIC_CONTRAST = 3;

/** A mark whose shapes paint themselves, rather than inheriting the ink. */
const isColourMark = (file: string) =>
  !/\sfill="currentColor"/.test(readAsset(file));

/** Colour marks, by file — the set the contrast floor applies to. */
const colourMarkFiles = assetFiles.filter(isColourMark);

const isOnOnyx = (file: string) =>
  file.endsWith("-dark.svg") || file.endsWith("-mono.svg");

/**
 * The surfaces a mark file is drawn on.
 *
 * A file with a per-scheme sibling is drawn on its own surface only — that is
 * what the sibling is for. Anything else is drawn on both.
 */
const PAIRED = [
  "gladia.svg",
  "gladia-dark.svg",
  "openrouter.svg",
  "openrouter-mono.svg",
];
const surfacesOf = (file: string) =>
  PAIRED.includes(file) ? [isOnOnyx(file) ? ONYX : CREAM] : [CREAM, ONYX];

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

  it("carries every attribute of every shape through to the JSX", () => {
    // The emitter reads tags by hand, so this is the check that hand-reading is
    // faithful: every attribute in the artwork must appear in the generated
    // module, except the three the component owns itself. A silently dropped
    // `transform` or `fill-rule` would ship a visibly wrong mark and nothing
    // else in this suite would notice.
    const generated = readFileSync(join(here, "ProviderLogos.tsx"), "utf8");
    const ours = new Set(["xmlns", "width", "height"]);
    // SVG's kebab-case attributes are React's camelCase props, which is exactly
    // the rename the test is here to hold the emitter to.
    const asProp = (name: string) =>
      name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    for (const file of assetFiles) {
      for (const [, name] of readAsset(file).matchAll(
        /\s([A-Za-z0-9:_-]+)="/g,
      )) {
        if (ours.has(name)) continue;
        expect(generated, `${file} drops ${name}`).toContain(asProp(name));
      }
    }
  });

  it("keeps one tag's attributes in source order", () => {
    // The emitter walks tags by hand rather than matching them, and a version
    // of it silently dropped every attribute while still emitting valid JSX.
    // The drift test only caught that because the committed module had been
    // generated by the previous version; this asserts it against the artwork as
    // it is now, so the next rewrite fails here instead. Its sibling below
    // sweeps every attribute in every file; this one also pins the order.
    const generated = readFileSync(join(here, "ProviderLogos.tsx"), "utf8");
    const ours = new Set(["xmlns", "width", "height"]);
    const asProp = (name: string) =>
      name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

    let checked = 0;
    for (const file of assetFiles) {
      // One representative tag per file: the longest start tag, which carries
      // the most attributes and the most chances to lose one.
      const tags = [...readAsset(file).matchAll(/<[a-z][^>]*>/g)].map(
        (match) => match[0],
      );
      const longest = tags.reduce(
        (best, tag) => (tag.length > best.length ? tag : best),
        "",
      );
      const names = [...longest.matchAll(/\s([A-Za-z0-9:_-]+)="/g)]
        .map((match) => match[1])
        .filter((name) => !ours.has(name));
      expect(names.length, `${file} has attributes`).toBeGreaterThan(0);

      // The generated props for that tag, in order.
      const wanted = names.map(asProp);
      const pattern = new RegExp(
        wanted.map((name) => `${name}="[^"]*"`).join("[\\s\\S]*?"),
      );
      expect(generated, `${file} keeps ${wanted.join(", ")}`).toMatch(pattern);
      checked += 1;
    }
    expect(checked).toBe(assetFiles.length);
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
    // exists (see `ARTWORK` in the component and the asset README).
    //
    // Paired marks are NOT exempt from the other surface: the pair exists
    // precisely because the light artwork fails on onyx, so a light file must
    // still clear the floor on cream and its dark sibling on onyx. Asserting
    // that here is what stops someone pointing `dark` at the light file.
    for (const file of colourMarkFiles) {
      const fills = [...readAsset(file).matchAll(/fill="(#[0-9a-fA-F]{6})"/g)];
      expect(fills.length, `${file} declares a brand fill`).toBeGreaterThan(0);
      for (const [, hex] of fills) {
        for (const surface of surfacesOf(file)) {
          const ratio = contrast(hex, surface);
          expect(ratio, `${file} ${hex} on ${surface}`).toBeGreaterThanOrEqual(
            MIN_GRAPHIC_CONTRAST,
          );
        }
      }
    }
  });

  it("covers every surface each colour mark is drawn on", () => {
    // The floor is only worth asserting over the set of surfaces actually used.
    // A per-scheme pair is drawn on one surface each; a single file is drawn on
    // both. If the mapping ever grows a third case, this fails rather than
    // silently measuring nothing.
    expect(colourMarkFiles.length).toBeGreaterThan(0);
    for (const file of colourMarkFiles) {
      expect(surfacesOf(file).length, `${file} has a surface`).toBeGreaterThan(
        0,
      );
    }
    // The two marks whose published colour fails on one surface are the reason
    // this test exists; pin them so a "simplification" cannot quietly drop the
    // measurement rather than the exception.
    expect(colourMarkFiles).toContain("openrouter.svg");
    expect(colourMarkFiles).toContain("gladia.svg");
    expect(surfacesOf("openrouter.svg")).toEqual([CREAM]);
    expect(surfacesOf("openrouter-mono.svg")).toEqual([ONYX]);
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

  /**
   * The scheme is read when the provider mounts, so a component already on
   * screen does not follow a scheme change — MUI updates `systemMode` through
   * its media-query listener, not on re-render. Each scheme therefore gets its
   * own mount, which is also how the app behaves: the surface is painted before
   * the marks are drawn on it.
   */
  const renderOnDarkSurface = (node: React.ReactElement) => {
    setMatchMedia((query) => query.includes(": dark"));
    render(node);
  };

  it("draws Gladia's navy mark on the light surface", () => {
    // Gladia's mark is dark navy, which the onyx surface swallows; this is the
    // light half of the pair.
    render(createElement(ProviderLogo, { provider: "gladia" }));
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "#141A2A",
    );
  });

  it("swaps Gladia for the white sibling on the dark surface", () => {
    // The half that would have passed vacuously if the test never left cream.
    renderOnDarkSurface(createElement(ProviderLogo, { provider: "gladia" }));
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "#FFFFFF",
    );
  });

  it("draws OpenRouter's published violet on the light surface", () => {
    render(createElement(ProviderLogo, { provider: "openrouter" }));
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "#7624f4",
    );
  });

  it("draws OpenRouter in the ink where the violet fails the floor", () => {
    // OpenRouter's violet measures under 3:1 on onyx, so onyx gets the same
    // silhouette in the text ink instead — a different mechanism from Gladia's
    // second file, and a legibility bug rather than a missing file if it
    // regressed.
    renderOnDarkSurface(
      createElement(ProviderLogo, { provider: "openrouter" }),
    );
    // The mono mark declares no fill, so it inherits the component's ink.
    expect(container.querySelector("path")?.getAttribute("fill")).toBeNull();
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
    // These three have no verifiable artwork; the list is pinned so adding a
    // provider without artwork is a deliberate edit to this test.
    expect(missing.sort()).toEqual(
      ["aldea", "openai-compatible", "speaches"].sort(),
    );
  });
});
