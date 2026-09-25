// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toast } from "sonner";
import { theme } from "../../theme";

import { SonnerToaster } from "./SonnerToaster";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
});

const styleText = () =>
  Array.from(document.querySelectorAll("style"))
    .map((node) => node.textContent ?? "")
    .join("\n");

describe("SonnerToaster", () => {
  it("paints one neutral surface per toast and carries status in the icon", async () => {
    await act(async () => {
      root?.render(
        <ThemeProvider theme={theme}>
          <SonnerToaster />
        </ThemeProvider>,
      );
    });

    const css = styleText();

    // Neutral card tuned to the surface ladder (not sonner's stock block).
    expect(css).toContain("[data-sonner-toast][data-styled='true']");
    expect(css).toContain("--normal-bg");

    // Status is carried by the icon per type…
    expect(css).toContain(
      "[data-sonner-toast][data-type='success'] [data-icon]",
    );
    expect(css).toContain("var(--app-palette-success-main");
    expect(css).toContain("[data-sonner-toast][data-type='error'] [data-icon]");
    expect(css).toContain("var(--app-palette-error-main");
    expect(css).toContain("[data-sonner-toast][data-type='info'] [data-icon]");

    // …actions are a quiet raised chip (Undo), never the inverted slab…
    expect(css).toContain(
      "[data-sonner-toast][data-styled='true'] [data-button]",
    );
    expect(css).toContain("var(--app-palette-level2");

    // …and richColors (saturated type fills) stays off for good.
    await act(async () => {
      toast.success("Copied successfully");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).not.toBeNull();
    expect(toaster!.getAttribute("data-rich-colors")).not.toBe("true");
    const toastEl = document.querySelector(
      "[data-sonner-toast][data-type='success']",
    );
    expect(toastEl).not.toBeNull();
    expect(toastEl!.querySelector("[data-icon]")).not.toBeNull();
    expect(toastEl!.textContent).toContain("Copied successfully");
  });
});
