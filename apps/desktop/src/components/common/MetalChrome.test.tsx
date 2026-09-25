// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Simulate metal-fx before its shader has painted a first frame: the wrapper
// is hidden through inline style, exactly like the real library.
vi.mock("metal-fx", () => ({
  MetalFx: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div
      data-testid="metal-root"
      className={className}
      style={{ opacity: 0, visibility: "hidden" }}
    >
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(__dirname, "MetalChrome.css"), "utf8");
  document.head.appendChild(style);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.head.innerHTML = "";
});

it("keeps the wrapped control visible before the shader paints", () => {
  act(() =>
    root.render(
      <MetalChrome variant="circle" className="extra">
        <button type="button">Play</button>
      </MetalChrome>,
    ),
  );
  const wrapper = container.querySelector<HTMLElement>(
    "[data-testid=metal-root]",
  )!;
  expect(wrapper.classList).toContain("mv-metal-chrome");
  expect(wrapper.classList).toContain("extra");
  const computed = getComputedStyle(wrapper);
  expect(computed.visibility).toBe("visible");
  expect(computed.opacity).toBe("1");
});
