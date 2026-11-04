// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { SettingGroup } from "./SettingRow";
import { PillPlacementSetting } from "./PillPlacementSetting";

vi.mock("../../utils/env.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/env.utils")>()),
  isWindows: () => true,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();
it("exposes pill placement as a heading beneath its settings group", () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          <SettingGroup title="Pill">
            <PillPlacementSetting />
          </SettingGroup>,
        ),
      ),
    );
    expect(host.querySelector("h2")?.textContent).toBe("Pill");
    const heading = host.querySelector('[role="heading"][aria-level="3"]');
    expect(heading?.textContent).toBe("Pill placement");
    expect(
      host.querySelector('[role="tablist"][aria-label="Pill placement"]'),
    ).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
