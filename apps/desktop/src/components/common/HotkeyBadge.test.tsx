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
  getKeycapLegend: (key: string) =>
    key === "ShiftLeft" ? { label: "⇧", sublabel: "Left" } : { label: key },
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
  Array.from(container.querySelectorAll("span[aria-hidden=true]"));

const renderClickable = (keys: string[]) =>
  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <HotkeyBadge keys={keys} onClick={() => undefined} />
      </ThemeProvider>,
    );
  });

it.each([
  ["read-only", false],
  ["clickable", true],
])("never renders a keycap as a native button (%s)", (_name, clickable) => {
  act(() => {
    if (clickable) renderClickable(["ControlLeft", "KeyK"]);
    else render(["ControlLeft", "KeyK"]);
  });
  expect(caps().length).toBe(2);
  for (const cap of caps()) {
    expect(cap.tagName).toBe("SPAN");
    expect(cap.hasAttribute("tabindex")).toBe(false);
    expect(cap.hasAttribute("role")).toBe(false);
  }
  expect(container.querySelector("button button")).toBeNull();
});

it("renders the optional 3D dashboard caps inside one named button", () => {
  const onClick = vi.fn();
  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <HotkeyBadge
          keys={["ShiftLeft", "KeyK"]}
          onClick={onClick}
          appearance="3d"
        />
      </ThemeProvider>,
    );
  });
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-label")).toBe("ShiftLeft + KeyK");
  expect(button?.querySelector("button")).toBeNull();
  const caps = Array.from(
    button?.querySelectorAll('[data-keycap-view="front"]') ?? [],
  );
  expect(caps).toHaveLength(2);
  expect(caps[0].closest('[aria-hidden="true"]')).not.toBeNull();
  expect(
    caps[0].querySelector('[data-keycap-part="sublabel"]')?.textContent,
  ).toBe("Left");
  expect(caps[0].querySelector('[data-keycap-part="glyph"]')?.textContent).toBe(
    "⇧",
  );
  act(() => button?.click());
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("keeps long legends readable in a 3D badge", () => {
  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <HotkeyBadge keys={["Enter", "KeyK"]} appearance="3d" />
      </ThemeProvider>,
    );
  });
  const group = container.querySelector('[role="group"]');
  expect(group?.getAttribute("aria-label")).toBe("Enter + KeyK");
  expect(group?.textContent).toContain("Enter");
  expect(group?.querySelectorAll('[data-keycap-view="front"]')).toHaveLength(1);
});

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
    const group = container.querySelector('[role="group"]');
    if (!group) throw new Error('Expected a [role="group"] badge to render');
    expect(getComputedStyle(group).padding).toBe("16px");
    expect(getComputedStyle(group).display).toBe("inline-flex");
  },
);
