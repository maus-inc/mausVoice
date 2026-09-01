#!/usr/bin/env node
/**
 * Regenerates the repository badge SVGs in docs/assets/badges/.
 *
 * Style: black capsule (shadcn default-button look), 1px hairline border,
 * light inner top highlight, soft drop shadow, label in Geist Medium at 62%
 * white, value in Geist SemiBold. Text is converted to outlines with
 * opentype.js so the badge carries no font dependencies (GitHub will not
 * load remote fonts from <img> SVGs; outlines render identically everywhere).
 *
 * Icon badges are optically centered on the glyph's bounding box (via
 * svg-path-bbox), not on its 24-unit viewBox, which matters for glyphs
 * whose content is not centered in the viewBox.
 *
 * Usage:
 *   cd docs/assets/badges/source
 *   npm install
 *   node generate-badges.mjs
 *
 * To use Satoshi instead of Geist, point FONT_MEDIUM/FONT_SEMIBOLD at
 * marketing/assets/fonts/ (only Satoshi Medium ships as TTF today).
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import opentype from "opentype.js";
import { svgPathBbox } from "svg-path-bbox";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..");

const FONT_MEDIUM = path.join(here, "fonts", "Geist-500.ttf");
const FONT_SEMIBOLD = path.join(here, "fonts", "Geist-600.ttf");

const medium = opentype.loadSync(FONT_MEDIUM);
const semibold = opentype.loadSync(FONT_SEMIBOLD);
const glyphs = JSON.parse(fs.readFileSync(path.join(here, "glyphs.json"), "utf8"));

// -- design tokens ----------------------------------------------------------
const H = 35; // capsule height
const RX = 7.5; // corner radius
const SIZE = 16.25; // text size
const GAP = 7.5; // label/value gap
const TEXT_PADX = 12.5; // capsule side padding for text badges
const ICON = 17.5; // platform glyph box
const ICON_PADX = 11.25;
const PAD_SIDE = 7; // canvas padding around the capsule (shadow spread)
const PAD_TOP = 4;
const PAD_BOTTOM = 7;

// shadow: soft, offset down
const BLUR = 2.2;
const SHADOW_DY = 2.2;
const SHADOW_OPACITY = 0.32;

const BLACK = "#000000";
const WHITE = "#ffffff";

// -- helpers ----------------------------------------------------------------
const fmt = (n) => Math.round(n * 100) / 100;

function textPath(font, text, size) {
  const p = font.getPath(text, 0, 0, size, { kerning: true });
  return { d: p.toPathData(2), width: font.getAdvanceWidth(text, size, { kerning: true }) };
}

function measureTextBadge(label, value) {
  return textPath(medium, label, SIZE).width + GAP + textPath(semibold, value, SIZE).width;
}

/** Text badge: dim label + bright value, centered at (cx, baseY). */
function textContent(label, value, cx, baseY) {
  const lab = textPath(medium, label, SIZE);
  const val = textPath(semibold, value, SIZE);
  let x = cx - (lab.width + GAP + val.width) / 2;
  let out = `<path d="${lab.d}" transform="translate(${fmt(x)} ${fmt(baseY)})" fill="${WHITE}" fill-opacity="0.62"/>`;
  x += lab.width + GAP;
  out += `<path d="${val.d}" transform="translate(${fmt(x)} ${fmt(baseY)})" fill="${WHITE}"/>`;
  return out;
}

/** Icon-only badge: white glyph optically centered on its bounding box. */
function iconContent(glyph, cx, centerY) {
  const s = ICON / 24;
  const [x0, y0, x1, y1] = svgPathBbox(glyph);
  const tx = cx - ((x0 + x1) / 2) * s;
  const ty = centerY - ((y0 + y1) / 2) * s;
  return `<path d="${glyph}" transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(s)})" fill="${WHITE}" fill-opacity="0.95"/>`;
}

/** Full document: shadow -> capsule -> top light -> hairline -> content. */
function frame(name, capsuleW, contentSvg) {
  const w = capsuleW + PAD_SIDE * 2;
  const h = H + PAD_TOP + PAD_BOTTOM;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="0 0 ${fmt(w)} ${fmt(h)}" role="img" aria-label="${name}">
  <title>${name}</title>
  <defs>
    <filter id="ds-${name}" x="-20%" y="-20%" width="140%" height="160%">
      <feGaussianBlur stdDeviation="${BLUR}"/>
    </filter>
    <linearGradient id="tl-${name}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${WHITE}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${WHITE}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="cp-${name}"><rect x="${PAD_SIDE}" y="${PAD_TOP}" width="${fmt(capsuleW)}" height="${H}" rx="${RX}"/></clipPath>
  </defs>
  <rect x="${PAD_SIDE}" y="${fmt(PAD_TOP + SHADOW_DY)}" width="${fmt(capsuleW)}" height="${H}" rx="${RX}" fill="${BLACK}" opacity="${SHADOW_OPACITY}" filter="url(#ds-${name})"/>
  <rect x="${PAD_SIDE}" y="${PAD_TOP}" width="${fmt(capsuleW)}" height="${H}" rx="${RX}" fill="${BLACK}"/>
  <g clip-path="url(#cp-${name})">
    <rect x="${PAD_SIDE}" y="${PAD_TOP}" width="${fmt(capsuleW)}" height="${fmt(H * 0.42)}" fill="url(#tl-${name})"/>
    <rect x="${fmt(PAD_SIDE + 0.5)}" y="${fmt(PAD_TOP + 0.5)}" width="${fmt(capsuleW - 1)}" height="${fmt(H - 1)}" rx="${fmt(RX - 0.5)}" fill="none" stroke="${WHITE}" stroke-opacity="0.16"/>
    <rect x="${fmt(PAD_SIDE + RX * 0.5)}" y="${fmt(PAD_TOP + 0.75)}" width="${fmt(capsuleW - RX)}" height="1" rx="0.5" fill="${WHITE}" fill-opacity="0.18"/>
  </g>
  ${contentSvg}
</svg>
`;
}

const BASE_Y = PAD_TOP + H / 2 + SIZE * 0.355; // cap-height centered baseline
const CENTER_Y = PAD_TOP + H / 2;

// -- badge manifest ---------------------------------------------------------
const textBadges = [
  ["license", "license", "AGPL-3.0"],
  ["downloads", "downloads", "all platforms"],
];

const iconBadges = [
  ["macos", glyphs.apple],
  ["windows", glyphs.windows],
  ["linux", glyphs.linux],
];

for (const [name, label, value] of textBadges) {
  const capsuleW = measureTextBadge(label, value) + TEXT_PADX * 2;
  const content = textContent(label, value, PAD_SIDE + capsuleW / 2, BASE_Y);
  fs.writeFileSync(path.join(OUT, `${name}.svg`), frame(name, capsuleW, content));
  console.log(`${name}.svg -> capsule ${fmt(capsuleW)}px`);
}

for (const [name, glyph] of iconBadges) {
  const capsuleW = ICON + ICON_PADX * 2;
  const content = iconContent(glyph, PAD_SIDE + capsuleW / 2, CENTER_Y);
  fs.writeFileSync(path.join(OUT, `${name}.svg`), frame(name, capsuleW, content));
  console.log(`${name}.svg -> capsule ${fmt(capsuleW)}px`);
}

console.log("done:", OUT);
