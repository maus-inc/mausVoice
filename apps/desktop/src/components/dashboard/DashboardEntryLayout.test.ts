import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DashboardEntryLayout } from "./DashboardEntryLayout";

/**
 * Strip style blocks, HTML attributes, and self-closing tags from SSR output
 * to reveal the pure element hierarchy. This avoids brittle coupling to
 * MUI-generated class names (e.g. MuiStack-root, MuiContainer-maxWidthSm,
 * css-{hash}) which can change across library upgrades without a layout
 * regression.
 *
 * Input:  `<style>.css-abc{flex-direction:column}</style><div class="MuiStack-root css-abc123"><div class="MuiContainer-root">x</div></div>`
 * Output: `<div><div>x</div></div>`
 */
function stripToStructure(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "") // remove emotion <style> blocks (tags may carry attributes e.g. data-emotion)
    .replaceAll(/\s[^>]*>/g, ">") // strip attributes from all other tags
    .replace(/<[^>]*\/>/g, "") // remove self-closing tags (e.g. <br/>)
    .trim();
}

describe("DashboardEntryLayout", () => {
  it("renders children inside the layout", () => {
    const html = renderToStaticMarkup(
      createElement(
        DashboardEntryLayout,
        null,
        createElement("span", null, "child-text"),
      ),
    );
    expect(html).toContain("child-text");
  });

  it("wraps children in exactly two div layers (Stack > Container)", () => {
    const html = renderToStaticMarkup(
      createElement(
        DashboardEntryLayout,
        null,
        createElement("span", null, "x"),
      ),
    );
    const openDivs = html.match(/<div\b/g) || [];
    // Stack renders as a div, Container renders as a div, and the child is a
    // span — so exactly two divs means no extra scrolling wrappers.
    expect(openDivs).toHaveLength(2);
  });

  it("propagates the maxWidth prop to the Container element", () => {
    const htmlSm = renderToStaticMarkup(
      createElement(DashboardEntryLayout, {
        maxWidth: "sm",
        children: createElement("span", null, "x"),
      }),
    );
    const htmlXl = renderToStaticMarkup(
      createElement(DashboardEntryLayout, {
        maxWidth: "xl",
        children: createElement("span", null, "x"),
      }),
    );
    // Different maxWidth values produce different Container attributes (width
    // class / style), so the full HTML strings must differ.
    expect(htmlSm).not.toBe(htmlXl);
  });

  it("does not introduce additional wrapping elements that would indicate a nested scroll container", () => {
    const html = renderToStaticMarkup(
      createElement(
        DashboardEntryLayout,
        null,
        createElement("span", null, "no-scroll"),
      ),
    );
    // Strip style blocks and attributes to get the raw tag hierarchy. The
    // structure must be exactly <div>…<div>…children…</div>…</div> — a scroll
    // container would add another wrapping layer or an element with
    // scroll-related content.
    //
    // Note: MUI `sx` props compile to emotion hashed class names whose style
    // rules are rendered inside <style> blocks by renderToStaticMarkup, so a
    // string-based assertion (e.g. not.toContain("overflow-y")) is meaningless
    // here. Instead we verify the structural contract: a flat layout wrapper
    // with no extra nesting that could indicate a nested scroll context. Full
    // scroll-behavior verification requires a mounted render with jsdom, but
    // the repo convention deliberately avoids jsdom for component tests.
    const structure = stripToStructure(html);
    expect(structure).toBe("<div><div><span>no-scroll</span></div></div>");
  });
});
