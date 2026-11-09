/**
 * Builds `apps/desktop/src/components/common/provider-logos/ProviderLogos.tsx`
 * from the vendored SVG artwork in
 * `apps/desktop/src/assets/provider-logos/`.
 *
 *   pnpm --filter desktop run gen:provider-logos
 *
 * Why a generator instead of `?react` imports
 * ------------------------------------------
 * The desktop app has `vite-plugin-svgr`, but `apps/preview` does not, and the
 * preview imports the real desktop components directly. An `import Logo from
 * "…svg?react"` would therefore typecheck in the app and fail in the preview.
 * Emitting one plain React module keeps a single artefact that both bundles can
 * consume, with no per-app plugin, no `.d.ts` shim and no runtime `fetch`.
 *
 * The generated file is committed. `src/components/common/provider-logos/
 * ProviderLogos.test.ts` re-runs this generator and fails if the committed module
 * has drifted from the artwork, so the two can never disagree.
 *
 * The generator only understands the SVG subset the artwork actually uses
 * (`path`, `rect`, `g`, `defs`, `linearGradient`, `stop`). A new file with
 * anything else is rejected instead of being silently flattened — add the
 * element to `JSX_ATTRS` when that happens.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const assetsDir = join(desktopRoot, "src", "assets", "provider-logos");
const outFile = join(
  desktopRoot,
  "src",
  "components",
  "common",
  "provider-logos",
  "ProviderLogos.tsx",
);

const ELEMENTS = new Set([
  "path",
  "rect",
  "g",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
]);

/** Attribute name → prop name. Everything else must already be camelCase. */
const JSX_ATTRS = {
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "clip-path": "clipPath",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "gradient-units": "gradientUnits",
  "gradient-transform": "gradientTransform",
  "color-interpolation-filters": "colorInterpolationFilters",
  "flood-opacity": "floodOpacity",
  "flood-color": "floodColor",
};

/**
 * React treats `id` values as global, and two marks on one page may both carry
 * `id="a"`. SVG paint servers are resolved by document-wide id, so a duplicate
 * would make one mark paint itself with the other's gradient. Ids are therefore
 * namespaced by provider at generation time.
 */
const namespaceIds = (body, provider) => {
  const ids = [
    ...new Set([...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
  ];
  let out = body;
  for (const id of ids) {
    const safe = `${provider}-${id}`.replace(/[^A-Za-z0-9_-]/g, "");
    out = out
      .replaceAll(`id="${id}"`, `id="${safe}"`)
      .replaceAll(`url(#${id})`, `url(#${safe})`)
      .replaceAll(`href="#${id}"`, `href="#${safe}"`);
  }
  return out;
};

const toJsxAttrs = (tag, attrs, provider) => {
  const parts = [];
  for (const [, rawName, rawValue] of attrs) {
    if (rawName === "xmlns" || rawName === "width" || rawName === "height")
      continue;
    const value = namespaceIds(rawValue, provider).replaceAll('"', "&quot;");
    const name = JSX_ATTRS[rawName] ?? rawName;
    parts.push(`${name}="${value}"`);
  }
  // React's SVG typing wants a literal string for `id`-bearing attributes, and
  // a double space in `viewBox` breaks nothing but reads badly.
  return parts.join(" ").replaceAll("  ", " ");
};

const selfClosing = new Set(["path", "rect", "stop", "circle", "ellipse"]);

/** One SVG document → JSX children, indented for the generated module. */
const toJsx = (svg, provider) => {
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();

  const out = [];
  const stack = [];
  let depth = 1;

  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      depth -= 1;
      stack.pop();
      out.push(`${"  ".repeat(depth)}</${name}>`);
      continue;
    }
    if (token.startsWith("<")) {
      const name = /^<([A-Za-z0-9:-]+)/.exec(token)?.[1];
      if (!name) throw new Error(`unparsable tag in ${provider}: ${token}`);
      if (!ELEMENTS.has(name)) {
        throw new Error(
          `${provider}: unsupported SVG element <${name}>. Add it to ELEMENTS/JSX_ATTRS in scripts/generate-provider-logos.mjs.`,
        );
      }
      const attrs = [...token.matchAll(/([A-Za-z0-9:_-]+)="([^"]*)"/g)];
      const rendered = toJsxAttrs(name, attrs, provider);
      if (token.endsWith("/>")) {
        out.push(
          `${"  ".repeat(depth)}<${name}${rendered ? ` ${rendered}` : ""} />`,
        );
      } else {
        out.push(
          `${"  ".repeat(depth)}<${name}${rendered ? ` ${rendered}` : ""}>`,
        );
        stack.push(name);
        depth += 1;
      }
      continue;
    }
    const text = token.trim();
    if (text) throw new Error(`${provider}: unexpected text node "${text}"`);
  }

  if (stack.length) throw new Error(`${provider}: unclosed <${stack.at(-1)}>`);
  return out;
};

const pascal = (id) =>
  id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const viewBoxOf = (svg, provider) => {
  const match = /viewBox="([^"]+)"/.exec(svg);
  if (!match) throw new Error(`${provider}: missing viewBox`);
  return match[1].split(/\s+/).join(" ");
};

const rootFillOf = (svg) => /<svg[^>]*\sfill="([^"]+)"/.exec(svg)?.[1] ?? null;

/**
 * The fill a mark's root element carries, in priority order:
 *
 * 1. the artwork's own root fill, when it declares one;
 * 2. `currentColor`, when a shape inside the mark has no fill of its own. That
 *    is not a missing colour — it is how a two-tone mark is published (Cerebras
 *    ships its ring in orange and its "C" in whatever text colour surrounds
 *    it), and baking an ink there would make the mark illegible in the other
 *    scheme;
 * 3. nothing, when every shape paints itself.
 */
const resolveRootFill = (svg) => {
  const declared = rootFillOf(svg);
  if (declared) return declared;
  const shapes = [...svg.matchAll(/<(?:path|rect|circle|ellipse)\b[^>]*>/g)];
  const unstyled = shapes.some((match) => !/\sfill="/.test(match[0]));
  return unstyled ? "currentColor" : null;
};

export function buildModule() {
  const files = readdirSync(assetsDir)
    .filter((name) => name.endsWith(".svg"))
    .sort();

  const entries = [];
  for (const file of files) {
    const raw = readFileSync(join(assetsDir, file), "utf8");
    const id = file.replace(/\.svg$/, "");
    const component = `ProviderLogo${pascal(id)}`;
    const viewBox = viewBoxOf(raw, id);
    // The root fill is the only colour decision a mark gets; `null` means every
    // child paints itself. See `resolveRootFill`.
    const rootFill = resolveRootFill(raw);
    entries.push({
      id,
      component,
      length: raw.length,
      file,
      viewBox,
      inkColor: rootFill === "none" ? null : rootFill,
      body: toJsx(raw, id),
    });
  }

  const components = entries
    .map(({ component, viewBox, inkColor, body, file }) => {
      // The artwork file is named in the doc comment so a reader can go from a
      // mark back to the exact bytes it was generated from.
      const title = `/** \`${file}\` — drawn at the caller's size, never recoloured. */`;
      const fill = inkColor ? ` fill="${inkColor}"` : "";
      return `${title}
const ${component} = (props: IconProps) => (
  <svg aria-hidden focusable="false" viewBox="${viewBox}"${fill} {...props}>
    ${body.join("\n    ")}
  </svg>
);`;
    })
    .join("\n\n");

  const map = entries
    .map(({ id, component }) => `  "${id}": ${component},`)
    .join("\n");

  return `// GENERATED FILE — do not edit by hand.
// Regenerate with: pnpm --filter desktop run gen:provider-logos
// Source artwork: apps/desktop/src/assets/provider-logos/ (see README.md there
// for provenance, licences and the mark-colour rules).
//
// The artwork is vendored rather than fetched: \`tauri.conf.json\` allows
// \`img-src 'self' asset: data: blob:\` and nothing else, so a hot-linked logo
// would be blocked in the packaged app and would leak the fact that the person
// opened settings to a third party.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

${components}

/**
 * Provider marks, by the id their asset file carries.
 *
 * A mark is decoration next to a provider's name — it never stands in for the
 * name on its own unless the caller labels it (\`role="img"\` + \`aria-label"\`).
 */
export const PROVIDER_LOGOS = {
${map}
} as const;

export type ProviderLogoId = keyof typeof PROVIDER_LOGOS;
`;
}

/**
 * The generated module is checked by `prettier --check src` like every other
 * source file, so the emitter runs the same formatter instead of re-implementing
 * its wrapping rules and drifting from them.
 *
 * Resolved through `createRequire` on purpose. A plain `import "prettier"`
 * becomes the browser `standalone` build when this script is loaded by Vitest
 * (which resolves the `browser` condition), and that build carries no TypeScript
 * parser, so the drift test would fail on resolution rather than on drift.
 */
const format = async (source) => {
  const prettier = createRequire(import.meta.url)("prettier");
  return prettier.format(source, { filepath: outFile });
};

export async function writeModule({ check = false } = {}) {
  const next = await format(buildModule());
  let previous = null;
  try {
    previous = readFileSync(outFile, "utf8");
  } catch {
    previous = null;
  }
  if (check) {
    if (previous !== next) {
      throw new Error(
        `${relative(process.cwd(), outFile)} is stale. Run: pnpm --filter desktop run gen:provider-logos`,
      );
    }
    return { file: outFile, changed: false };
  }
  if (previous === next) return { file: outFile, changed: false };
  writeFileSync(outFile, next);
  return { file: outFile, changed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { file, changed } = await writeModule({
    check: process.argv.includes("--check"),
  });
  console.log(
    `${changed ? "wrote" : "unchanged"} ${relative(process.cwd(), file)}`,
  );
}
