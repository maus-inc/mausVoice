// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * These tests guard three separate contracts. jsdom has no layout and does not
 * run CSS animations, so none of them can prove the control is hit-testable in
 * a real webview; that still needs a manual check.
 *  1. Class contract: MetalChrome always tags the metal-fx wrapper.
 *  2. Stylesheet contract: the tag carries a delayed, `forwards` reveal that
 *     only takes over after the library's own fade window.
 *  3. Library contract (canary): metal-fx still hides the wrapper through
 *     inline opacity/visibility gated on its first frame copy. If a release
 *     switches to a class, data attribute, or pointer-events, this fails so the
 *     safety net gets revisited instead of silently going stale.
 */

vi.mock("metal-fx", () => ({
  MetalFx: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="metal-root" className={className}>
      {children}
    </div>
  ),
}));
vi.mock("@mui/material", () => ({
  useColorScheme: () => ({ mode: "dark", systemMode: "dark" }),
  useTheme: () => ({ palette: { mode: "dark" } }),
}));
vi.mock("framer-motion", () => ({ useReducedMotion: () => false }));

import { MetalChrome } from "./MetalChrome";

// Comments are stripped so the assertions below bind to declarations only,
// never to prose that happens to quote a selector or keyword.
const css = readFileSync(join(__dirname, "MetalChrome.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MetalChrome", () => {
  it("tags the wrapper with the reveal safety-net class", () => {
    act(() =>
      root.render(
        <MetalChrome variant="circle" className="extra">
          <button type="button">Play</button>
        </MetalChrome>,
      ),
    );
    const wrapper = container.querySelector("[data-testid=metal-root]")!;
    expect(wrapper.classList).toContain("mv-metal-chrome");
    expect(wrapper.classList).toContain("extra");
    expect(wrapper.querySelector("button")?.textContent).toBe("Play");
  });

  it("reveals via a delayed forwards animation instead of !important", () => {
    const rule = /\.mv-metal-chrome\s*{([^}]*)}/.exec(css)?.[1];
    expect(rule, "missing .mv-metal-chrome rule").toBeDefined();
    const animation =
      /animation:\s*mv-metal-chrome-reveal\s+\S+\s+\S+\s+(\d+)ms\s+forwards\s*;/.exec(
        rule!,
      );
    expect(animation, `unexpected rule body: ${rule}`).not.toBeNull();
    // Long enough for the library's own first-frame fade to win normally.
    expect(Number(animation![1])).toBeGreaterThanOrEqual(300);
    expect(rule).not.toContain("!important");

    const keyframes =
      /@keyframes mv-metal-chrome-reveal\s*{([\s\S]*?)}\s*}/.exec(css)?.[1];
    expect(keyframes, "missing reveal keyframes").toBeDefined();
    expect(keyframes).not.toContain("!important");
    const to = /to\s*{([^}]*)/.exec(keyframes!)?.[1] ?? "";
    expect(to).toMatch(/opacity:\s*1\s*;/);
    expect(to).toMatch(/visibility:\s*visible\s*;/);
  });

  it("still matches how metal-fx hides the wrapper (library canary)", () => {
    // Read whatever file the package entry resolves to (not a guessed dist
    // path), so a rebuild or re-layout of metal-fx cannot break this check.
    const require = createRequire(import.meta.url);
    const entry = require.resolve("metal-fx", {
      paths: [join(__dirname, "../../..")],
    });
    const source = readFileSync(entry, "utf8");
    const hint =
      `metal-fx (${entry}) no longer hides its wrapper via inline ` +
      "opacity/visibility gated on onFirstCopy. Re-check that " +
      "MetalChrome.css still rescues controls when the shader never paints.";
    expect(source, hint).toContain("onFirstCopy");
    expect(source, hint).toMatch(/opacity:\s*\w+\s*\?\s*1\s*:\s*0/);
    expect(source, hint).toMatch(
      /visibility:\s*\w+\s*\?\s*"visible"\s*:\s*"hidden"/,
    );
  });
});
