// @vitest-environment jsdom
import { Dialog, TextField } from "@mui/material";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { stopComposingEscape } from "../common/ime-keyboard";
import { ConfirmationField } from "./ConfirmationField";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();

it.each(["profile", "confirmation"])(
  "leaves composing Escape in the %s input, while ordinary Escape dismisses",
  (kind) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    try {
      act(() =>
        root.render(
          <IntlProvider locale="en" messages={en}>
            <Dialog open onClose={onClose}>
              {kind === "profile" ? (
                <TextField label="Name" onKeyDown={stopComposingEscape} />
              ) : (
                <ConfirmationField
                  phrase="clear"
                  value=""
                  onChange={() => {}}
                />
              )}
            </Dialog>
          </IntlProvider>,
        ),
      );
      const input = document.querySelector("[role=dialog] input")!;
      for (const init of [{ isComposing: true, which: 27 }, { keyCode: 229 }]) {
        const event = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          ...init,
        });
        act(() => input.dispatchEvent(event));
        expect(onClose).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      }
      act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
