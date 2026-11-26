// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { ThemeProvider } from "@mui/material";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { OpenRouterProviderRouting } from "./OpenRouterProviderRouting";

ensureUiHarness();

/**
 * The routing header's chevron is the one glyph in the settings surface whose
 * colour is a state rather than a constant, so it is asserted on the element
 * that renders it. The rule lives in the provider's own `sx`, which Emotion
 * only emits once the component mounts, so a stylesheet read from a row cannot
 * see it and this mounts the component itself.
 */
const ruleFor = (className: string, suffix = ""): string => {
  const css = Array.from(document.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("");
  const needle = `.${className}${suffix}`;
  const start = css.indexOf(needle + "{");
  if (start < 0) throw new Error(`no rule for ${needle}`);
  return css.slice(start, css.indexOf("}", start) + 1);
};

describe("routing chevron", () => {
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

  it("rests muted and lifts to the primary tone on hover", () => {
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            ThemeProvider,
            { theme, ...THEME_PROVIDER_CONFIG },
            createElement(OpenRouterProviderRouting, {
              apiKeyId: "preview-key",
            }) as never,
          ),
        ),
      );
    });

    const header = container.querySelector(".expand-icon")?.parentElement;
    const generated = Array.from(header?.classList ?? []).find((name) =>
      name.startsWith("css-"),
    );
    expect(generated).toBeTruthy();

    // The resting colour the header sets for the glyph, and the hover colour
    // that replaces it. Asserting only the hover rule would pass on a header
    // where the glyph inherits the title's tone and nothing visibly changes.
    const css = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("");
    expect(css).toContain(
      ".expand-icon{color:var(--app-palette-text-secondary)",
    );
    expect(css).toContain(".expand-icon{color:var(--app-palette-text-primary)");
    expect(ruleFor(String(generated)).length).toBeGreaterThan(0);
  });
});
