import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AnimateIn } from "./AnimateIn";

// Behavioral contract for AnimateSwitch's PresenceGuard wrapper.
//
// Under the default "node" vitest environment (jsdom is intentionally avoided —
// it previously tripped Socket's obfuscated-code scanner) we render to static
// markup and assert the *visible outcome* rather than grepping the source:
// the children render when visible, and are removed from the DOM when not
// (the PresenceGuard/AnimatePresence contract), instead of being leaked as a
// stale fragment.
describe("AnimateSwitch rendering", () => {
  it("renders its children when visible", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: true,
        children: createElement("span", null, "hello-pill"),
      }),
    );
    expect(html).toContain("hello-pill");
  });

  it("removes children from the DOM when not visible (presence wrap, not leak)", () => {
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

  it("wraps children in a single element (no fragment leak)", () => {
    const html = renderToStaticMarkup(
      createElement(AnimateIn, {
        visible: true,
        children: createElement("span", null, "wrapped-pill"),
      }),
    );
    // Exactly one root element wrapping the child span.
    expect(html.startsWith("<div")).toBe(true);
    expect(html).toContain("<span");
    expect(html.endsWith("</div>")).toBe(true);
  });
});
