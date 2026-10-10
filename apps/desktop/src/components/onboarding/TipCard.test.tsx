// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { TipCardFrame } from "./TipCard";

ensureUiHarness();
setMatchMedia(false);

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

describe("TipCardFrame", () => {
  const frameCard = (): HTMLElement => {
    const target = container.querySelector('[role="note"]');
    if (!(target instanceof HTMLElement)) {
      throw new Error("Card not found in frame");
    }
    return target;
  };

  const renderFrame = (
    props: Parameters<typeof TipCardFrame>[0] &
      Partial<Parameters<typeof TipCardFrame>[0]>,
  ) =>
    act(() => {
      root.render(
        createElement(
          ThemeProvider,
          { theme, ...THEME_PROVIDER_CONFIG },
          createElement(MemoryRouter, null, createElement(TipCardFrame, props)),
        ),
      );
    });

  it("renders the title, body, icon, and dismiss control", async () => {
    const onDismiss = vi.fn();
    await renderFrame({
      title: "Title",
      body: "Body",
      icon: createElement("span", { className: "lucide" }),
      onDismiss,
    });

    expect(container.textContent).toContain("Title");
    expect(container.textContent).toContain("Body");
    expect(container.querySelector(".lucide")).toBeTruthy();

    const dismiss = container.querySelector('button[aria-label="Dismiss tip"]');
    if (!(dismiss instanceof HTMLButtonElement)) {
      throw new Error("Dismiss control not found");
    }
    act(() => dismiss.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders no dismiss control when onDismiss is omitted", async () => {
    await renderFrame({ title: "Title", body: "Body" });

    expect(
      container.querySelector('button[aria-label="Dismiss tip"]'),
    ).toBeNull();
  });

  it("applies plain-object sx overrides on top of the base card", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: { opacity: 0.42 },
    });

    expect(getComputedStyle(frameCard()).opacity).toBe("0.42");
  });

  it("applies array-form sx (HelpPage passes [dismissed && {...}])", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: [{ opacity: 0.5 }],
    });

    expect(getComputedStyle(frameCard()).opacity).toBe("0.5");
  });

  it("applies function-form sx resolved against the theme", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: (t) => ({ opacity: 0.42, color: (t as typeof theme).palette.level1 }),
    });

    const card = frameCard();
    expect(getComputedStyle(card).opacity).toBe("0.42");
    // Resolve the expected color from the theme itself so the assertion
    // tracks the token instead of a copy of it.
    const hex = (theme.palette.level1 as string).slice(1);
    const [r, g, b] = [0, 2, 4].map((i) =>
      Number.parseInt(hex.slice(i, i + 2), 16),
    );
    expect(getComputedStyle(card).color).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("lets sx overrides beat the base card styles", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: { borderTopWidth: 3 },
    });

    expect(getComputedStyle(frameCard()).borderTopWidth).toBe("3px");
  });
});
