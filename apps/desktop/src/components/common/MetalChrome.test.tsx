// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

const css = readFileSync(join(__dirname, "MetalChrome.css"), "utf8");

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
    const rule = /\.mv-metal-chrome\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(
      /animation:\s*mv-metal-chrome-reveal\s+\S+\s+\S+\s+(\d+)ms\s+forwards/,
    );
    const delay = Number(/(\d+)ms\s+forwards/.exec(rule)?.[1]);
    // Long enough for the library's own first-frame fade to win normally.
    expect(delay).toBeGreaterThanOrEqual(300);
    expect(css).not.toContain("!important");

    const keyframes =
      /@keyframes mv-metal-chrome-reveal\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? "";
    const to = /to\s*{([^}]*)}/.exec(keyframes)?.[1] ?? "";
    expect(to).toMatch(/opacity:\s*1/);
    expect(to).toMatch(/visibility:\s*visible/);
  });

  it("still matches how metal-fx hides the wrapper (library canary)", () => {
    const require = createRequire(import.meta.url);
    // Resolves to <pkg>/dist/index.cjs.js; the ESM build sits beside it.
    const distDir = dirname(
      require.resolve("metal-fx", { paths: [join(__dirname, "../../..")] }),
    );
    const source = readFileSync(join(distDir, "index.es.js"), "utf8");
    expect(source).toContain("onFirstCopy");
    expect(source).toMatch(/opacity:\s*\w+\s*\?\s*1\s*:\s*0/);
    expect(source).toMatch(/visibility:\s*\w+\s*\?\s*"visible"\s*:\s*"hidden"/);
  });
});
