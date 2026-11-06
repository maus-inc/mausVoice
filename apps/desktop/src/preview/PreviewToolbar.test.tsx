// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("./runtime", () => ({
  applyPreviewScenario: vi.fn(),
  getActivePreviewScenario: () => "populated",
}));
vi.mock("../components/root/RootDialogs", () => ({ RootDialogs: () => null }));
vi.mock("../components/root/RootConfetti", () => ({
  RootConfetti: () => null,
}));
vi.mock("../components/root/SnackbarEmitter", () => ({
  SnackbarEmitter: () => null,
}));

import { PreviewRoot } from "./PreviewRoot";
import { applyPreviewScenario } from "./runtime";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <MemoryRouter>
          <PreviewRoot />
        </MemoryRouter>
      </IntlProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it("starts hidden and restores the card without resetting scenario data", async () => {
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Show preview popup"]',
  );
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggle!.click());
  expect(container.querySelector('[role="combobox"]')).not.toBeNull();
  expect(toggle?.getAttribute("aria-label")).toBe("Hide preview popup");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle!.click());
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.textContent).not.toContain("Reset data");
  expect(applyPreviewScenario).not.toHaveBeenCalled();
});
