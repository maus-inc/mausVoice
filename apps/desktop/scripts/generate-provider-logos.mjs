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

/** Elements this emitter knows how to render. */
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

const toJsxAttrs = (attrs, provider) =>
  attrs
    .filter(
      ({ name }) => name !== "xmlns" && name !== "width" && name !== "height",
    )
    .map(({ name, value }) => {
      const quoted = namespaceIds(value, provider).replaceAll('"', "&quot;");
      const prop = JSX_ATTRS[name] ?? name;
      return `${prop}="${quoted}"`;
    })
    // A double space in `viewBox` breaks nothing but reads badly.
    .join(" ")
    .replaceAll("  ", " ");

/**
 * Indentation per nesting level.
 *
 * A cached table rather than `"  ".repeat(depth)` at each call site: the depth
 * is the only thing that varies, and the array reads as what it is.
 */
const INDENT = [
  "",
  "  ",
  "    ",
  "      ",
  "        ",
  "          ",
  "            ",
  "              ",
];
const indent = (depth) => INDENT[depth] ?? "  ".repeat(depth);

/**
 * Splits an SVG document into tags and text, in one pass.
 *
 * Walked by hand rather than matched: `/<[^>]*>|[^<]+/g` is the obvious
 * spelling, and on a file full of unterminated `<` it is quadratic — every `<`
 * rescans to the end of the document before giving up. Two `indexOf` calls
 * cannot. Real artwork never hits that, but a generator that hangs on a hostile
 * file is not a generator anyone wants running in CI.
 */
const scan = (body) => {
  const tokens = [];
  let at = 0;
  while (at < body.length) {
    const tag = body[at] === "<";
    // A tag runs to its `>`, including it; text runs to the next `<`.
    const close = body.indexOf(tag ? ">" : "<", at);
    // Unterminated: the rest of the document is the last token.
    const end = close === -1 ? body.length : close + Number(tag);
    tokens.push(body.slice(at, end));
    at = end;
  }
  return tokens;
};

/** The element name a start tag opens, validated against `ELEMENTS`. */
const tagNameOf = (token, provider) => {
  const tag = token.slice(1);
  const end = tag.search(/[\s/>]/);
  const name = end === -1 ? tag : tag.slice(0, end);
  if (!name) throw new Error(`${provider}: unparsable tag ${token}`);
  if (!ELEMENTS.has(name)) {
    throw new Error(
      `${provider}: unsupported SVG element <${name}>. Add it to ELEMENTS/JSX_ATTRS in scripts/generate-provider-logos.mjs.`,
    );
  }
  return name;
};

/** Whitespace that separates attributes inside a tag. */
const SPACES = [" ", "\t", "\n", "\r"];

/** Index of one of `stops`, or `length` when the string ends first. */
const until = (text, from, stops) => {
  let at = from;
  while (at < text.length && !stops.includes(text[at])) at += 1;
  return at;
};

const NAME_STOPS = [" ", "\t", "\n", "\r", "=", "/", ">"];

/**
 * A start tag's attributes as `{ name, value }`.
 *
 * Scanned by hand rather than matched. The obvious regex
 * (`[A-Za-z0-9:_-]+="[^"]*"`) is quadratic on a token with a long run before a
 * missing `=`: the engine retries the run from every character. Walking the
 * token once cannot, and a malformed tag throws where a silent no-match would
 * have emitted broken JSX.
 */
const attrsOf = (token) => {
  const attrs = [];
  let at = 1; // past `<`
  while (at < token.length) {
    // Step over the separator itself; `until` stops *on* it, so re-entering the
    // loop without this would read the same space forever.
    at = until(token, at, SPACES) + 1;
    if (at >= token.length) break;
    const nameStart = at;
    at = until(token, at, NAME_STOPS);
    const name = token.slice(nameStart, at);
    // A `/`, `>` or `=` where a name should be: step past it. Without this the
    // loop re-enters on the same character forever, because a tag ends in `/`
    // and no `name=` pair will ever start there.
    if (!name) {
      at += 1;
      continue;
    }
    if (token[at] !== "=") continue;
    if (token[at + 1] !== '"') {
      throw new Error(`unquoted attribute "${name}"`);
    }
    const valueEnd = token.indexOf('"', at + 2);
    if (valueEnd === -1) {
      throw new Error(`unterminated attribute "${name}"`);
    }
    attrs.push({ name, value: token.slice(at + 2, valueEnd) });
    at = valueEnd + 1;
  }
  return attrs;
};

/** The JSX for one start tag, and the name it opens if it is not self-closing. */
const startTagOf = (token, provider, depth) => {
  const name = tagNameOf(token, provider);
  const attrs = toJsxAttrs(attrsOf(token), provider);
  const open = attrs ? `<${name} ${attrs}` : `<${name}`;
  const selfClosing = token.endsWith("/>");
  return {
    name,
    line: `${indent(depth)}${open}${selfClosing ? " />" : ">"}`,
    selfClosing,
  };
};

/** One SVG document → JSX children, indented for the generated module. */
const toJsx = (svg, provider) => {
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();

  const out = [];
  const stack = [];
  // Children of the root `<svg>` start one level in.
  let depth = 1;

  for (const token of scan(body)) {
    if (token.startsWith("</")) {
      depth -= 1;
      out.push(`${indent(depth)}</${stack.pop()}>`);
      continue;
    }

    if (!token.startsWith("<")) {
      const text = token.trim();
      if (text) throw new Error(`${provider}: unexpected text node "${text}"`);
      continue;
    }

    const { name, line, selfClosing } = startTagOf(token, provider, depth);
    out.push(line);
    if (!selfClosing) {
      stack.push(name);
      depth += 1;
    }
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
  return match[1].replaceAll(/\s+/g, " ");
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
