// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";
import { ToneEditConfirmations } from "./ToneEditConfirmations";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

ensureUiHarness();

it.each(["delete", "discard"] as const)(
  "starts on Cancel and does not confirm when Cancel is activated in the %s confirmation",
  async (kind) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onDelete = vi.fn();
    const onDiscard = vi.fn();
    const onCancelDelete = vi.fn();
    const onCancelDiscard = vi.fn();
    try {
      await act(async () => {
        root.render(
          <IntlProvider locale="en">
            <ThemeProvider theme={theme}>
              <ToneEditConfirmations
                deleteOpen={kind === "delete"}
                discardOpen={kind === "discard"}
                isBusy={false}
                onDelete={onDelete}
                onDiscard={onDiscard}
                onCancelDelete={onCancelDelete}
                onCancelDiscard={onCancelDiscard}
              />
            </ThemeProvider>
          </IntlProvider>,
        );
      });
      const cancel = document.activeElement as HTMLButtonElement;
      expect(cancel.tagName).toBe("BUTTON");
      expect(cancel.textContent).toBe("Cancel");
      // JSDOM does not dispatch the browser's synthesized click on Enter.
      await act(async () => cancel.click());
      expect(
        kind === "delete" ? onCancelDelete : onCancelDiscard,
      ).toHaveBeenCalledOnce();
      expect(onDelete).not.toHaveBeenCalled();
      expect(onDiscard).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
