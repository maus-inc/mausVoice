#!/usr/bin/env node
// Generates the 3D ASCII-element SVGs used as edge decorations on the bento
// cards of the docs landing page. Renders each ASCII art string as monospace
// text in an SVG so the shapes stay crisp and can be filtered (inverted) on
// theme switch.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "assets", "cards");
mkdirSync(outDir, { recursive: true });

const art = {
  cube: `\
      +--------+
     /        /|
    /        / |
   +--------+  |
   |        |  |
   |        |  +
   |        | /
   |        |/
   +--------+`,
  pyramid: `\
          /\\
         /  \\
        /    \\
       /______\\
        \\      \\
         \\______\\`,
  sphere: `\
      .-"""-.
     /       \\
    |  o   o  |
    |    .    |
     \\  .-.  /
      '-...-'`,
  diamond: `\
       /\\
      /  \\
     / /\\ \\
    / /  \\ \\
    \\ \\  / /
     \\ \\/ /
      \\  /
       \\/`,
};

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (const [name, ascii] of Object.entries(art)) {
  const lines = ascii.split("\n");
  const cols = Math.max(...lines.map((l) => l.length));
  const rows = lines.length;

  const texts = lines
    .map((line, i) => {
      // White strokes so the artwork reads clearly on the dark cards; a
      // `filter: invert(1)` on light theme turns the white to black.
      return `\t<text x="0" y="${i + 1}" font-size="1" fill="#ffffff">${escapeXml(line)}</text>`;
    })
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols}" height="${rows}" viewBox="0 0 ${cols} ${rows + 1}" role="presentation">
\t<style>
\t\ttext {
\t\t\tfont-family: "JetBrains Mono", ui-monospace, monospace;
\t\t\tletter-spacing: 0;
\t\t\twhite-space: pre;
\t\t}
\t</style>
${texts}
</svg>
`;

  writeFileSync(join(outDir, `ascii-${name}.svg`), svg, "utf8");
  console.log(`wrote ascii-${name}.svg (${cols} x ${rows})`);
}
