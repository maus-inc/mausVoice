/**
 * Check that every guide figure's markers match its annotation list.
 *
 * A figure with four annotations and three drawn badges sends a reader looking
 * for a badge that is not there, and the reverse leaves a badge with no copy.
 * Two sources have to agree: the annotation list in the MDX and the `markers`
 * wired to that figure in `figures.mjs`. A guide that points at a figure the
 * capture script does not know about also fails, because that image would
 * never be refreshed.
 *
 * Run through the docs `lint` script so it fails the same gate as Prettier.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_FIGURES } from "./figures.mjs";

const docsRoot = fileURLToPath(new URL("..", import.meta.url));
const contentDir = join(docsRoot, "src/content/docs");

const filesIn = (dir, entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return mdxFiles(path);
  return entry.name.endsWith(".mdx") ? [path] : [];
};

const mdxFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesIn(dir, entry)));
  return nested.flat();
};

const annotationCount = (block) => (block.match(/\{ n: \d+,/g) ?? []).length;

const figureBlocks = (mdx) => {
  const blocks = [];
  for (const match of mdx.matchAll(/<Figure\b([\s\S]*?)\/>/g)) {
    const id = match[1].match(/id="([^"]+)"/);
    if (id) blocks.push({ id: id[1], count: annotationCount(match[1]) });
  }
  return blocks;
};

const drawnMarkers = new Map(
  Object.entries(APP_FIGURES).map(([id, recipe]) => [
    id,
    (recipe.markers ?? []).length,
  ]),
);

const sources = await Promise.all(
  (await mdxFiles(contentDir)).map(async (file) => ({
    name: file.slice(contentDir.length + 1),
    source: await readFile(file, "utf8"),
  })),
);

const failures = [];
const rows = [];
for (const { name, source } of sources) {
  for (const { id, count } of figureBlocks(source)) {
    const drawn = drawnMarkers.get(id);
    if (drawn === undefined) {
      failures.push(`${name}: figure "${id}" has no capture in figures.mjs`);
      continue;
    }
    rows.push({ name, id, count, drawn });
    if (count !== drawn) {
      failures.push(
        `${name}: figure "${id}" lists ${count} annotations but draws ${drawn} markers`,
      );
    }
  }
}

for (const [id, drawn] of drawnMarkers) {
  if (drawn > 0 && !rows.some((row) => row.id === id)) {
    failures.push(
      `capture "${id}" draws markers but no guide lists annotations for it`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.map((line) => `  ${line}`).join("\n"));
  console.error(`figure markers: ${failures.length} problem(s)`);
  process.exit(1);
}

const total = rows.reduce((sum, row) => sum + row.drawn, 0);
console.log(
  `figure markers: ${rows.length} figures, ${total} markers, every count matches its annotation list`,
);
