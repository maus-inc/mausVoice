// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({ update: vi.fn(), load: vi.fn() }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../../store", () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      settings: {
        openRouterProviders: [
          { slug: "a", name: "Alpha" },
          { slug: "b", name: "Beta" },
        ],
        openRouterProvidersStatus: "success",
      },
    }),
}));
vi.mock("../../actions/openrouter.actions", () => ({
  getOpenRouterConfigForKey: () => ({ providerRouting: { order: ["a"] } }),
  loadOpenRouterProviders: mocks.load,
  updateOpenRouterProviderRouting: mocks.update,
}));
import { OpenRouterProviderRouting } from "./OpenRouterProviderRouting";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("disables keyboard controls during persistence and restores them when it settles", async () => {
  let resolveSave: () => void = () => undefined;
  mocks.update.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(OpenRouterProviderRouting, { apiKeyId: "key" }),
      ),
    );
    const header = [...container.querySelectorAll("p")].find(
      (element) => element.textContent === "Advanced Routing",
    );
    if (!header) throw new Error("Routing header missing");
    act(() => header.click());
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!checkbox) throw new Error("Fallback checkbox missing");
    act(() => checkbox.click());
    expect(mocks.update).toHaveBeenCalledWith("key", {
      order: ["a"],
      allow_fallbacks: false,
    });
    expect(checkbox.disabled).toBe(true);
    expect(
      [
        ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].every((input) => input.disabled),
    ).toBe(true);
    expect(
      container
        .querySelector('[role="combobox"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    expect(checkbox.disabled).toBe(false);
    expect(
      [
        ...container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].every((input) => !input.disabled),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
