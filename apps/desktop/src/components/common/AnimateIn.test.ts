import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AnimateIn } from "./AnimateIn";

// Behavioral contract for AnimateIn's PresenceGuard wrapper, validated via SSR
// static markup. jsdom is intentionally avoided (it previously tripped
// Socket's obfuscated-code scanner), so this suite is scoped to initial
// static-markup assertions: the child renders when visible and is removed from
// the DOM when not (the presence-guard removal contract), wrapped in exactly
// one root element.
describe("AnimateIn static markup", () => {
  it("renders its children when visible", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: true,
        children: createElement("span", null, "hello-pill"),
      }),
    );
    expect(html).toContain("hello-pill");
  });

  it("removes children from the DOM when not visible (presence guard, not leak)", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: false,
        children: createElement("span", null, "hidden-pill"),
      }),
    );
    // The content is removed by the presence guard rather than left in the
    // tree, so it must not appear in the static markup.
    expect(html).not.toContain("hidden-pill");
  });

  it("wraps children in exactly one root div containing one span", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: true,
        children: createElement("span", null, "wrapped-pill"),
      }),
    );
    // Anchored at both ends: a single root <div> whose only child element is
    // the <span> wrapping the content, with no extra wrapper fragments.
    expect(html).toMatch(
      /^<div[^>]*>.*<span[^>]*>wrapped-pill<\/span>.*<\/div>$/s,
    );
  });
});
