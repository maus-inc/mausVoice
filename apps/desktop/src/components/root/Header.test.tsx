// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";

vi.mock("@tauri-apps/api/app", () => ({
  getIdentifier: async () => "preview",
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import en from "../../i18n/locales/en.json";
import { createPreviewScenario } from "../../preview/scenarios";
import { setAppState } from "../../store";
import { AppHeader } from "./Header";

ensureUiHarness();

describe("AppHeader", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("bounds an unusually long profile name without losing its accessible text", async () => {
    const snapshot = createPreviewScenario("populated");
    const name = "Alexandria" + "a".repeat(100);
    const user =
      snapshot.state.userById[Object.keys(snapshot.state.userById)[0]];
    user.name = name;
    setAppState(snapshot.state, true);
    await act(async () =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AppHeader),
        ),
      ),
    );
    const text = requireElement(
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes(name))
        ?.querySelector(".MuiTypography-noWrap"),
      "the bounded name",
    );
    const button = requireElement(
      text.closest("button"),
      "the profile menu button",
    );
    expect(text.textContent).toBe(name);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(button).maxWidth).toBe("320px");
  });
});
