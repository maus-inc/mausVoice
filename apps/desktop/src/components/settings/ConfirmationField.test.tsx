// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { ConfirmationField } from "./ConfirmationField";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

ensureUiHarness();

it("describes each confirmation field with its own visible phrase", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <ConfirmationField phrase="clear" value="" onChange={() => {}} />
          <ConfirmationField phrase="delete" value="" onChange={() => {}} />
        </IntlProvider>,
      );
    });
    const fields = container.querySelectorAll("input");
    expect(fields).toHaveLength(2);
    const ids = Array.from(fields, (field) =>
      field.getAttribute("aria-describedby"),
    );
    expect(ids[0]).not.toBe(ids[1]);
    expect(document.getElementById(ids[0]!)?.textContent).toBe(
      "Type clear to confirm.",
    );
    expect(document.getElementById(ids[1]!)?.textContent).toBe(
      "Type delete to confirm.",
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
