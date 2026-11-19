// @vitest-environment jsdom
import { Dialog, DialogContent, TextField, ThemeProvider } from "@mui/material";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../test/helpers/jsdom-ui-harness";
import { theme } from "./theme";

ensureUiHarness();

it("keeps a composing Escape in dialog content without cancelling the key", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  try {
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <Dialog open onClose={close}>
            <DialogContent>
              <TextField label="Name" />
            </DialogContent>
          </Dialog>
        </ThemeProvider>,
      ),
    );
    const input = document.querySelector('[role="dialog"] input')!;
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      which: 27,
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(event));
    expect(close).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
