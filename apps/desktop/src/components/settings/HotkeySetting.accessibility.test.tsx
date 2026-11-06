// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { HotkeySetting } from "./HotkeySetting";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();
it("names the primary and additional recorders using their setting and ordinal", () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.hotkeyIds = ["primary", "extra"];
  state.hotkeyById = {
    primary: { id: "primary", actionName: "dictate", keys: ["KeyA"] },
    extra: { id: "extra", actionName: "dictate", keys: ["KeyB"] },
  };
  setAppState(state, true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(HotkeySetting, {
            title: "Hold to dictate",
            description: "Hold a key",
            actionName: "dictate",
          }),
        ),
      ),
    );
    const recorders = Array.from(
      host.querySelectorAll('[role="textbox"][tabindex="0"]'),
    );
    expect(recorders).toHaveLength(2);
    const name = (node: Element) =>
      (node.getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(name(recorders[0])).toBe("Hold to dictate Primary shortcut");
    expect(name(recorders[1])).toBe("Hold to dictate Additional shortcut 1");
    for (const recorder of recorders) {
      expect(
        document.getElementById(recorder.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBeTruthy();
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
