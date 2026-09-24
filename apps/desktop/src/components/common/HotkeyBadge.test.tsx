// @vitest-environment jsdom
import {
  createTheme,
  ThemeProvider,
  type SxProps,
  type Theme,
} from "@mui/material/styles";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

vi.mock("../../utils/keyboard.utils", () => ({
  getPrettyKeyName: (key: string) => key,
}));
import { HotkeyBadge } from "./HotkeyBadge";

ensureUiHarness();
const theme = createTheme({ cssVariables: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (keys: string[], sx?: SxProps<Theme>) =>
  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <HotkeyBadge keys={keys} sx={sx} />
      </ThemeProvider>,
    );
  });
const caps = () =>
  Array.from(container.querySelectorAll(".MuiButtonBase-root"));

it("preserves keycap identity when another modifier is inserted or reordered", () => {
  render(["ControlLeft", "KeyK"]);
  const [control, letter] = caps();
  render(["ShiftLeft", "KeyK", "ControlLeft"]);
  expect(caps()[1]).toBe(letter);
  expect(caps()[2]).toBe(control);
});

it("keeps repeated key identities unique without tying them to other keys' positions", () => {
  render(["KeyA", "KeyA"]);
  const original = caps();
  render(["ShiftLeft", "KeyA", "KeyA"]);
  caps()
    .slice(1)
    .forEach((cap, index) => expect(cap).toBe(original[index]));
  expect(caps()[1]).not.toBe(caps()[2]);
});

it.each([false, true])(
  "retains callback and array sx overrides (array=%s)",
  (array) => {
    const callback = (current: Theme) => ({
      padding: `${Number(current.shape.borderRadius) * 4}px`,
    });
    render(["KeyK"], array ? [{ margin: 1 }, callback] : callback);
    const group = container.querySelector('[role="group"]')!;
    expect(getComputedStyle(group).padding).toBe("16px");
    expect(getComputedStyle(group).display).toBe("inline-flex");
  },
);
