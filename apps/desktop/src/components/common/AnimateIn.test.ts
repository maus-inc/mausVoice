import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AnimateIn } from "./AnimateIn";

// Behavioral contract for AnimateIn's PresenceGuard wrapper, validated via SSR
// static markup. jsdom is intentionally avoided (it previously tripped
// Socket's obfuscated-code scanner), so this suite is scoped to initial
// static-markup assertions: the child renders when visible and is removed from
// the DOM when not (the presence-guard removal contract).
//
// Rendered structure (visible): an outer motion.div (the animated wrapper)
// containing the PresenceGuard div (aria-hidden reflects !isPresent) which in
// turn wraps the child element.
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

  it("omits children from initial SSR markup when not visible", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: false,
        children: createElement("span", null, "hidden-pill"),
      }),
    );
    // visible=false skips the motion.div/PresenceGuard branches before they
    // run, so the subtree is simply absent from the initial SSR output.
    expect(html).not.toContain("hidden-pill");
  });

  it("wraps children in the motion.div → PresenceGuard → span structure", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: true,
        children: createElement("span", null, "wrapped-pill"),
      }),
    );
    // Outer motion.div (animated wrapper) → PresenceGuard div (aria-hidden
    // reflects !isPresent) → the single child span. Anchored at both ends.
    expect(html).toMatch(
      /^<div[^>]*><div aria-hidden="false"><span[^>]*>wrapped-pill<\/span><\/div><\/div>$/,
    );
  });
});
