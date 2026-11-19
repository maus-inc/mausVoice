// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mock = vi.hoisted(() => ({
  options: null as null | { action: React.ReactNode; onDismiss: () => void },
}));
vi.mock("sonner", () => {
  const toast = Object.assign(
    (_message: string, options: NonNullable<typeof mock.options>) => {
      mock.options = options;
    },
    {
      dismiss: () => mock.options?.onDismiss(),
      error: vi.fn(),
      success: vi.fn(),
    },
  );
  return { toast };
});
import { emitSnackbarIfNew, resetSnackbarEmitForTests } from "./snackbar-emit";
ensureUiHarness();

it("returns focus only once when Undo triggers programmatic dismissal", () => {
  resetSnackbarEmitForTests();
  const onFocusReturn = vi.fn();
  emitSnackbarIfNew({
    snackbarCounter: 1,
    snackbarMessage: "Removed",
    snackbarAction: {
      label: "Undo",
      onClick: vi.fn(),
      onFocusReturn,
      focusOnShow: true,
      expiresAt: Date.now() + 5000,
    },
  });
  const host = document.createElement("div");
  host.setAttribute("data-sonner-toast", "");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(mock.options!.action));
    const button = host.querySelector("button")!;
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(onFocusReturn).toHaveBeenCalledOnce();
    expect(onFocusReturn).toHaveBeenCalledWith(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    resetSnackbarEmitForTests();
  }
});
