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
  getKeycapLegend: (key: string) => ({ label: key }),
}));
vi.mock("./Keycap3d", () => ({ Keycap3d: () => null }));
vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");
  return {
    motion: {
      span: ({
        initial,
        animate,
        transition,
        children,
      }: {
        initial: { transform: string };
        animate: { transform: string };
        transition: { type?: string; duration?: number };
        children: React.ReactNode;
      }) =>
        createElement(
          "span",
          {
            "data-start": initial.transform,
            "data-target": animate.transform,
            "data-transition": transition.type ?? String(transition.duration),
          },
          children,
        ),
    },
  };
});
import { KeyPressSimulator } from "./KeyPressSimulator";

ensureUiHarness();
const theme = createTheme({ cssVariables: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  held.keys = [];
  setMatchMedia(false);
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

it("targets each held key independently and starts newly captured keys at rest", () => {
  held.keys = ["KeyA"];
  render(["KeyA", "KeyB"]);
  const caps = container.querySelectorAll("[data-target]");
  expect(caps[0].getAttribute("data-start")).toBe("translateY(0px)");
  expect(caps[0].getAttribute("data-target")).toBe("translateY(5.76px)");
  expect(caps[1].getAttribute("data-target")).toBe("translateY(0px)");
  expect(caps[0].getAttribute("data-transition")).toBe("spring");
  held.keys = [];
  render(["KeyA", "KeyB"]);
  expect(caps[0].getAttribute("data-target")).toBe("translateY(0px)");
});

it("keeps held state visible without movement when reduced motion is requested", () => {
  setMatchMedia(true);
  held.keys = ["KeyA"];
  render(["KeyA"]);
  const cap = container.querySelector("[data-target]");
  expect(cap?.getAttribute("data-target")).toBe("translateY(0px)");
  expect(cap?.getAttribute("data-transition")).toBe("0");
  expect(container.querySelector('[data-key-state="pressed"]')).not.toBeNull();
  expect(
    container.querySelector('[data-combo-state="pressed"]'),
  ).not.toBeNull();
});
