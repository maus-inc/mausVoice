// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
vi.mock("../../utils/feature.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/feature.utils")>()),
  shouldShowFeatureReleaseDialog: () => true,
}));
vi.mock("../../actions/app.actions", () => ({ showConfetti: vi.fn() }));
vi.mock("../settings/HotkeySetting", () => ({ HotkeySetting: () => null }));
vi.mock("../settings/AIAgentModeConfiguration", () => ({
  AIAgentModeConfiguration: () => null,
}));

import { FeatureReleaseDialog } from "./FeatureReleaseDialog";
ensureUiHarness();

describe("FeatureReleaseDialog", () => {
  it("names the feature introduction across its pages", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          createElement(
            IntlProvider,
            { locale: "en", messages: en },
            createElement(FeatureReleaseDialog),
          ),
        ),
      );
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.getAttribute("aria-label")).toBe(
        "A more powerful mausVoice",
      );
      const next = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Next"),
      );
      if (!next) throw new Error("Missing Next button");
      act(() => next.click());
      expect(dialog?.getAttribute("aria-label")).toBe(
        "A more powerful mausVoice",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
