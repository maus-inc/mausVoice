// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import en from "../../i18n/locales/en.json";
import { ProviderSettingLinkStatus } from "./ProviderSettingLinkStatus";
import { useSettingsAvailability } from "./settings-availability";

const load = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../actions/api-key.actions", () => ({ loadApiKeys: load }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();
const Probe = () =>
  createElement(ProviderSettingLinkStatus, {
    availability: useSettingsAvailability(),
  });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  load.mockClear();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (hash: string) =>
  act(() =>
    root.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: en },
        createElement(
          MemoryRouter,
          { initialEntries: [`/dashboard/settings/privacy-data${hash}`] },
          createElement(Probe),
        ),
      ),
    ),
  );
const setStatus = (status: "error" | "success" | "loading") =>
  act(() =>
    setAppState((state) => ({
      ...state,
      settings: { ...state.settings, apiKeysStatus: status },
    })),
  );

it("explains the pending target, offers retry after failure, and reports an unavailable result", () => {
  render("#setting-elevenlabs_keyterms");
  expect(container.textContent).toContain("Loading provider settings");
  setStatus("error");
  expect(container.textContent).toContain("Could not load provider settings");
  const retry = container.querySelector("button");
  expect(retry?.textContent).toContain("Try again");
  act(() => retry?.click());
  expect(load).toHaveBeenCalledOnce();
  setStatus("success");
  expect(container.textContent).toContain("This setting is not available.");
  expect(container.querySelector("button")).toBeNull();
});
it("removes the status when the targeted row becomes available", () => {
  act(() =>
    root.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: en },
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              "/dashboard/settings/privacy-data#setting-elevenlabs_keyterms",
            ],
          },
          createElement(ProviderSettingLinkStatus, {
            availability: { elevenlabs_keyterms: true },
          }),
        ),
      ),
    ),
  );
  expect(container.textContent).toBe("");
});

it("does not add a status for an unrelated link", () => {
  render("#setting-incognito_mode");
  expect(container.textContent).toBe("");
});
