import { Button } from "@mui/material";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PaletteOverrideStyle,
  PatchedThemeProvider,
  SpecProvider,
  useSpec,
} from "./spec-store";

const OverrideSnapshot = () => (
  <output>{JSON.stringify(useSpec().overrides)}</output>
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("preview theme overrides", () => {
  it("layers an override over array and callback styles without mutating the theme", () => {
    localStorage.setItem(
      "maus-preview-spec-overrides-v1",
      JSON.stringify({ button: { radius: 24 } }),
    );
    const theme = createTheme({
      components: {
        MuiButton: {
          defaultProps: { disableElevation: true },
          styleOverrides: {
            root: [
              { borderRadius: 6, color: "rgb(1, 2, 3)" },
              ({ theme }) => ({ paddingTop: theme.spacing(3) }),
            ],
          },
        },
      },
    });
    const original = theme.components?.MuiButton;

    act(() => {
      root.render(
        <ThemeProvider theme={theme}>
          <SpecProvider>
            <PatchedThemeProvider>
              <Button>Preview</Button>
            </PatchedThemeProvider>
          </SpecProvider>
        </ThemeProvider>,
      );
    });

    const button = container.querySelector("button");
    if (!button) throw new Error("Expected the preview button to render");
    const style = getComputedStyle(button);
    expect(style.borderRadius).toBe("24px");
    expect(style.paddingTop).toBe("24px");
    expect(style.color).toBe("rgb(1, 2, 3)");
    expect(button?.className).toContain("MuiButton-disableElevation");
    expect(theme.components?.MuiButton).toBe(original);
    expect(original?.styleOverrides?.root).toEqual([
      { borderRadius: 6, color: "rgb(1, 2, 3)" },
      expect.any(Function),
    ]);
  });
});

describe("persisted override validation", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["string", "invalid"],
    ["null entry", { button: null }],
    ["array entry", { button: [] }],
    ["object field", { button: { radius: { value: 24 } } }],
    ["boolean field", { button: { radius: true } }],
    ["wrong scalar type", { button: { radius: "24" } }],
  ])("ignores a %s instead of trusting a TypeScript cast", (_name, stored) => {
    localStorage.setItem(
      "maus-preview-spec-overrides-v1",
      JSON.stringify(stored),
    );
    act(() =>
      root.render(
        <SpecProvider>
          <OverrideSnapshot />
        </SpecProvider>,
      ),
    );
    expect(container.textContent).toBe("{}");
  });

  it("keeps valid fields while dropping non-finite, stale and malformed fields", () => {
    localStorage.setItem(
      "maus-preview-spec-overrides-v1",
      '{"button":{"radius":24,"stale":1},"native-pill":{"expanded-w":1e400},"old-entry":{"value":3}}',
    );
    act(() =>
      root.render(
        <SpecProvider>
          <OverrideSnapshot />
        </SpecProvider>,
      ),
    );
    expect(JSON.parse(container.textContent ?? "")).toEqual({
      button: { radius: 24 },
    });
  });
});

/** The scheme sheet MUI's CssVarsProvider emits for
 *  `colorSchemeSelector: "data-mui-color-scheme"` with light as the default
 *  scheme — `createGetSelector` puts light on `:root, [data-...=light]` and
 *  dark on `[data-...=dark]` alone, at equal specificity. */
const mountThemeSchemeSheet = (): void => {
  const sheet = document.createElement("style");
  sheet.dataset.testSchemeSheet = "true";
  sheet.textContent = [
    ':root, [data-mui-color-scheme="light"] { --app-palette-level0: #0c0c0d-lightTheme; }',
    '[data-mui-color-scheme="dark"] { --app-palette-level0: #0c0c0d-darkTheme; }',
  ].join("\n");
  document.head.appendChild(sheet);
};

const mountPaletteOverrides = (
  overrides: Record<string, Record<string, string>>,
): void => {
  localStorage.setItem(
    "maus-preview-spec-overrides-v1",
    JSON.stringify(overrides),
  );
  act(() =>
    root.render(
      <SpecProvider>
        <PaletteOverrideStyle />
      </SpecProvider>,
    ),
  );
};

const rootLevel0 = (): string =>
  getComputedStyle(document.documentElement)
    .getPropertyValue("--app-palette-level0")
    .trim();

describe("scheme-scoped palette overrides", () => {
  beforeEach(() => {
    mountThemeSchemeSheet();
  });

  afterEach(() => {
    document
      .querySelectorAll("style[data-test-scheme-sheet]")
      .forEach((sheet) => sheet.remove());
    document.documentElement.removeAttribute("data-mui-color-scheme");
  });

  it("keeps a light-only override out of the dark scheme", () => {
    document.documentElement.setAttribute("data-mui-color-scheme", "dark");

    mountPaletteOverrides({ color: { "level0-light": "#abcdef" } });

    // The dark scheme must keep its own token: a bare `:root` in the light
    // block matches the dark `<html>` and, being mounted after MUI's sheet at
    // equal specificity, would win the cascade.
    expect(rootLevel0()).toBe("#0c0c0d-darkTheme");
  });

  it("applies a light-only override in the light scheme", () => {
    document.documentElement.setAttribute("data-mui-color-scheme", "light");

    mountPaletteOverrides({ color: { "level0-light": "#abcdef" } });

    expect(rootLevel0()).toBe("#abcdef");
  });

  it("still applies a dark-only override in the dark scheme", () => {
    document.documentElement.setAttribute("data-mui-color-scheme", "dark");

    mountPaletteOverrides({ color: { "level0-dark": "#fedcba" } });

    expect(rootLevel0()).toBe("#fedcba");
  });

  it("keeps each scheme's own override when both are edited", () => {
    document.documentElement.setAttribute("data-mui-color-scheme", "light");
    mountPaletteOverrides({
      color: { "level0-light": "#abcdef", "level0-dark": "#fedcba" },
    });
    expect(rootLevel0()).toBe("#abcdef");

    act(() => root.unmount());
    root = createRoot(container);
    document.documentElement.setAttribute("data-mui-color-scheme", "dark");
    mountPaletteOverrides({
      color: { "level0-light": "#abcdef", "level0-dark": "#fedcba" },
    });
    expect(rootLevel0()).toBe("#fedcba");
  });
});
