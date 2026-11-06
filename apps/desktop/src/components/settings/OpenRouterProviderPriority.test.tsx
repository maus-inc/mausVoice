// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { OpenRouterProviderPriority } from "./OpenRouterProviderPriority";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("renders priority controls and forwards move, removal and addition", async () => {
  const move = vi.fn();
  const remove = vi.fn();
  const add = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(OpenRouterProviderPriority, {
          providerOrder: ["a", "b"],
          availableToAdd: [{ slug: "c", name: "Charlie" }],
          getProviderName: (slug) => ({ a: "Alpha", b: "Beta" })[slug] ?? slug,
          onMoveProvider: move,
          onRemoveProvider: remove,
          onAddProvider: add,
        }),
      ),
    );
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    const ups = [
      ...container.querySelectorAll('[data-testid="ArrowUpwardIcon"]'),
    ].map((icon) => icon.closest("button"));
    const downs = [
      ...container.querySelectorAll('[data-testid="ArrowDownwardIcon"]'),
    ].map((icon) => icon.closest("button"));
    const deletes = [
      ...container.querySelectorAll('[data-testid="CloseIcon"]'),
    ].map((icon) => icon.closest("button"));
    expect(ups[0]?.disabled).toBe(true);
    expect(downs[1]?.disabled).toBe(true);
    act(() => {
      downs[0]?.click();
      ups[1]?.click();
      deletes[1]?.click();
    });
    expect(move.mock.calls).toEqual([
      [0, "down"],
      [1, "up"],
    ]);
    expect(remove).toHaveBeenCalledWith(1);
    const select = container.querySelector<HTMLElement>('[role="combobox"]');
    if (!select) throw new Error("Provider selection missing");
    await act(async () =>
      select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === "Charlie",
    );
    if (!option) throw new Error("Provider option missing");
    await act(async () => (option as HTMLElement).click());
    expect(add).toHaveBeenCalledWith("c");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("disables every priority control while a change is saving", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(OpenRouterProviderPriority, {
          disabled: true,
          providerOrder: ["a", "b"],
          availableToAdd: [{ slug: "c", name: "Charlie" }],
          getProviderName: (slug) => slug,
          onMoveProvider: vi.fn(),
          onRemoveProvider: vi.fn(),
          onAddProvider: vi.fn(),
        }),
      ),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(6);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(
      container
        .querySelector('[role="combobox"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
