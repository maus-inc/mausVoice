// @vitest-environment jsdom
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

const held = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: { keysHeld: string[] }) => unknown) =>
    selector({ keysHeld: held.keys }),
}));
vi.mock("../../utils/keyboard.utils", () => ({
  getPrettyKeyName: (key: string) => key,
  getKeycapLegend: (key: string) =>
    key === "ShiftLeft" ? { label: "⇧", sublabel: "Left" } : { label: key },
}));
import { KeyPressSimulator } from "./KeyPressSimulator";

ensureUiHarness();
const theme = createTheme({ cssVariables: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setMatchMedia(false);
  held.keys = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (keys: string[]) =>
  act(() =>
    root.render(
      <ThemeProvider theme={theme}>
        <KeyPressSimulator keys={keys} />
      </ThemeProvider>,
    ),
  );

it("shows the onboarding angle caps while keeping the shortcut accessible", () => {
  render(["ShiftLeft", "KeyK"]);
  const group = container.querySelector('[role="group"]');
  expect(group?.getAttribute("aria-label")).toBe("ShiftLeft + KeyK");
  expect(group?.getAttribute("data-combo-state")).toBe("idle");
  const caps = Array.from(
    container.querySelectorAll('[data-keycap-view="angle"]'),
  );
  expect(caps).toHaveLength(2);
  expect(caps[0].closest('[aria-hidden="true"]')).not.toBeNull();
  expect(
    caps[0].querySelector('[data-keycap-part="sublabel"]')?.textContent,
  ).toBe("Left");
  expect(caps[0].querySelector('[data-keycap-part="glyph"]')?.textContent).toBe(
    "⇧",
  );
});

it("tracks individual and complete shortcut presses", () => {
  render(["ShiftLeft", "KeyK"]);
  held.keys = ["ShiftLeft"];
  render(["ShiftLeft", "KeyK"]);
  expect(
    container.querySelector('[role="group"]')?.getAttribute("data-combo-state"),
  ).toBe("idle");
  expect(
    Array.from(container.querySelectorAll("[data-key-state]")).map((el) =>
      el.getAttribute("data-key-state"),
    ),
  ).toEqual(["pressed", "idle"]);
  const partial = container.querySelector('[data-key-state="pressed"]');
  expect(partial && getComputedStyle(partial).outline).toContain("solid");
  held.keys = ["ShiftLeft", "KeyK"];
  render(["ShiftLeft", "KeyK"]);
  expect(
    container.querySelector('[role="group"]')?.getAttribute("data-combo-state"),
  ).toBe("pressed");
  expect(
    Array.from(container.querySelectorAll("[data-key-state]")).map((el) =>
      el.getAttribute("data-key-state"),
    ),
  ).toEqual(["pressed", "pressed"]);
  held.keys = [];
  render(["ShiftLeft", "KeyK"]);
  expect(
    container.querySelector('[role="group"]')?.getAttribute("data-combo-state"),
  ).toBe("idle");
});

it("retains each key's motion element across partial presses and reordering", () => {
  render(["ShiftLeft", "KeyK"]);
  const [shift, letter] = container.querySelectorAll("[data-key-motion]");
  held.keys = ["KeyK"];
  render(["KeyK", "ShiftLeft"]);
  const reordered = container.querySelectorAll("[data-key-motion]");
  expect(reordered[0]).toBe(letter);
  expect(reordered[1]).toBe(shift);
  expect(
    Array.from(container.querySelectorAll("[data-key-state]")).map((el) =>
      el.getAttribute("data-key-state"),
    ),
  ).toEqual(["pressed", "idle"]);
});

it("does not mark an empty shortcut as pressed", () => {
  held.keys = ["KeyK"];
  render([]);
  expect(
    container.querySelector('[role="group"]')?.getAttribute("data-combo-state"),
  ).toBe("idle");
  expect(container.querySelectorAll("[data-key-motion]")).toHaveLength(0);
});
