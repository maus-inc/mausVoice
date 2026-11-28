// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import en from "../../../i18n/locales/en.json";
import es from "../../../i18n/locales/es.json";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: { runNativeSetup: mocks.run },
}));
vi.mock("../../../actions/app.actions", () => ({
  showSnackbar: mocks.success,
  showErrorSnackbar: mocks.error,
}));
vi.mock("../../../utils/platform.utils", () => ({
  getPlatform: () => "windows",
}));
vi.mock("../settings-availability", () => ({
  useSettingsAvailability: () => ({ always_run_as_administrator: false }),
}));
vi.mock("../UpdateChannelSetting", () => ({
  UpdateChannelSetting: () => null,
}));
vi.mock("../UpdateSettingSection", () => ({
  UpdateSettingSection: () => null,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import SystemSettingsPage from "./SystemSettingsPage";

ensureUiHarness();

it("disables setup after navigating away and back while the native prompt is pending", async () => {
  let finish!: (result: string) => void;
  mocks.run.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.success.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const page = () =>
    createElement(
      IntlProvider,
      { locale: "en", messages: en },
      createElement(SystemSettingsPage),
    );
  act(() => root.render(page()));
  const setup = () =>
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Configure input permissions"),
    );
  expect(setup()).toBeDefined();
  act(() => setup()!.click());
  const confirm = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Continue",
  );
  expect(confirm).toBeDefined();
  act(() => confirm!.click());
  expect(mocks.run).toHaveBeenCalledTimes(1);
  act(() => root.render(null));
  act(() => root.render(page()));
  expect(setup()?.disabled).toBe(true);
  await act(async () => {
    finish("success");
  });
  expect(setup()?.disabled).toBe(false);
  expect(mocks.success).toHaveBeenCalledWith("Input permissions configured.");
  act(() => root.unmount());
  container.remove();
});

it("shows a localized setup failure instead of the native error", async () => {
  mocks.run.mockReset().mockRejectedValueOnce("private native diagnostic");
  mocks.error.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        IntlProvider,
        { locale: "es", messages: es },
        createElement(SystemSettingsPage),
      ),
    ),
  );
  const setup = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Configurar permisos de entrada"),
  );
  act(() => setup!.click());
  const confirm = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Continuar",
  );
  await act(async () => {
    confirm!.click();
  });
  expect(mocks.error).toHaveBeenCalledWith(
    "No se pudieron configurar los permisos de entrada.",
  );
  expect(mocks.error).not.toHaveBeenCalledWith("private native diagnostic");
  act(() => root.unmount());
  container.remove();
});
