import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// Run after the Astro build: source-only checks do not catch MDX wrapping the
// decoration in an extra paragraph, which would add a visible empty line.
test("built homepage keeps each decorative element out of the card's text flow", () => {
  const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  const document = new JSDOM(html).window.document;
  const cards = [...document.querySelectorAll(".card-grid.stagger > .card")];
  const expected = [
    ["Get a first dictation working", "cube", "getting-started/overview/"],
    ["Use every daily feature", "pyramid", "using-mausvoice/app-tour/"],
    ["Configure providers correctly", "sphere", "configuration/settings-map/"],
    ["Understand the data flow", "diamond", "privacy-security/data-flow/"],
    ["Fix a broken pipeline", "pyramid", "troubleshooting/first-response/"],
    ["Build and contribute", "diamond-left", "development/repository-overview/"],
  ];
  assert.equal(cards.length, expected.length);
  for (const [index, [title, artwork, link]] of expected.entries()) {
    const card = cards[index];
    assert.equal(card.querySelector(".title")?.textContent?.trim(), title);
    const body = card.querySelector(".body");
    assert.ok(body);
    const children = [...body.children];
    assert.deepEqual(children.map((node) => node.tagName), ["SPAN", "P", "P"]);
    assert.equal(children[0].getAttribute("aria-hidden"), "true");
    assert.equal(children[0].className, `mv-docs-card-art mv-docs-card-art--${artwork}`);
    assert.equal(children[0].textContent, "");
    assert.equal(body.querySelector("a")?.getAttribute("href"), link);
  }
});

test("rendered code frames retain the theme's rounded surface", () => {
  const html = readFileSync(
    new URL("../dist/using-mausvoice/custom-styles/index.html", import.meta.url),
    "utf8",
  ).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const { window } = new JSDOM(html);
  const frame = window.document.querySelector(".expressive-code .frame");
  assert.ok(frame, "the built page must contain an Expressive Code frame");
  const style = window.document.createElement("style");
  style.textContent = readFileSync(new URL("../src/styles/custom.css", import.meta.url), "utf8");
  window.document.head.append(style);
  assert.equal(window.getComputedStyle(frame).borderRadius, "4px");
});
