// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { Breadcrumb } from "./Breadcrumb";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Breadcrumb", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("marks the last crumb as the current page and keeps earlier crumbs as buttons", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    await act(async () => {
      mounted.render(
        createElement(
          StrictMode,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(Breadcrumb, {
              items: [
                { label: "Home", href: "/dashboard" },
                { label: "History" },
              ],
            }),
          ),
        ),
      );
    });
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Breadcrumb");
    const current = container.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe("History");
    const links = container.querySelectorAll("button");
    expect(Array.from(links).map((el) => el.textContent)).toEqual(["Home"]);
  });
});
