// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { TimedSnackbarAction } from "./TimedSnackbarAction";
const dismiss = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { dismiss } }));
ensureUiHarness();
beforeEach(() => {
  vi.useFakeTimers();
  dismiss.mockReset();
});
afterEach(() => vi.useRealTimers());

it("focuses a keyboard undo, associates its message, and returns focus after undo", () => {
  const host = document.createElement("div");
  host.setAttribute("data-sonner-toast", "");
  host.innerHTML =
    '<div data-title>Transcript removed. Undo available for 5 seconds.</div><div id="action"></div>';
  document.body.append(host);
  const root = createRoot(host.querySelector("#action")!);
  const onClick = vi.fn(),
    onFocusReturn = vi.fn(),
    onMount = vi.fn();
  try {
    act(() =>
      root.render(
        <TimedSnackbarAction
          toastId="toast-1"
          onMount={onMount}
          action={{
            label: "Undo",
            onClick,
            onFocusReturn,
            focusOnShow: true,
            expiresAt: Date.now() + 5000,
          }}
        />,
      ),
    );
    const button = host.querySelector("button")!;
    expect(document.activeElement).toBe(button);
    expect(host.querySelector("[data-title]")?.id).toBe(
      button.getAttribute("aria-describedby"),
    );
    act(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(onFocusReturn).toHaveBeenCalledWith(true);
    expect(dismiss).toHaveBeenCalledWith("toast-1");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("expires at the undo deadline even while focused, but never steals moved focus", () => {
  const host = document.createElement("div");
  host.setAttribute("data-sonner-toast", "");
  document.body.append(host);
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  const root = createRoot(host);
  const onFocusReturn = vi.fn();
  const action = {
    label: "Undo",
    onClick: vi.fn(),
    onFocusReturn,
    focusOnShow: true,
    expiresAt: Date.now() + 5000,
  };
  try {
    act(() =>
      root.render(
        <TimedSnackbarAction
          toastId="toast-2"
          onMount={() => {}}
          action={action}
        />,
      ),
    );
    expect(document.activeElement).toBe(host.querySelector("button"));
    elsewhere.focus();
    act(() => vi.advanceTimersByTime(5000));
    expect(dismiss).toHaveBeenCalledWith("toast-2");
    expect(onFocusReturn).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    elsewhere.remove();
  }
});

it("returns focus when the focused undo expires", () => {
  const host = document.createElement("div");
  host.setAttribute("data-sonner-toast", "");
  document.body.append(host);
  const root = createRoot(host);
  const onFocusReturn = vi.fn();
  try {
    act(() =>
      root.render(
        <TimedSnackbarAction
          toastId="toast-3"
          onMount={() => {}}
          action={{
            label: "Undo",
            onClick: vi.fn(),
            onFocusReturn,
            focusOnShow: true,
            expiresAt: Date.now() + 5000,
          }}
        />,
      ),
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(onFocusReturn).toHaveBeenCalledWith(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
