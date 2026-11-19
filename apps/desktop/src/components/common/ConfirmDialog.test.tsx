// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ConfirmDialog } from "./ConfirmDialog";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// MUI's Dialog portals into document.body rather than the render container.
const confirmButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")].at(-1);
  if (!button) throw new Error("confirm button not rendered");
  return button as HTMLButtonElement;
};

const accessibleName = (button: HTMLButtonElement): string =>
  (button.textContent ?? "").trim();

const render = async (busy: boolean, confirmLabel?: string) => {
  await act(async () => {
    root.render(
      createElement(ConfirmDialog, {
        isOpen: true,
        title: "Delete account",
        content: "This cannot be undone.",
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        busy,
        ...(confirmLabel ? { confirmLabel } : {}),
      }),
    );
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("ConfirmDialog busy state", () => {
  it("keeps the confirm button's accessible name while it is busy", async () => {
    // The busy branch used to replace the label with a bare spinner, so the
    // disabled button had no accessible name at all and a screen reader
    // announced an unlabelled control with nothing to say what was in progress.
    await render(false);
    const idleName = accessibleName(confirmButton());
    expect(idleName).toBe("Confirm");

    await render(true);

    const button = confirmButton();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(accessibleName(button)).toBe(idleName);
    // And the progress indicator is named, rather than an anonymous spinner.
    const progress = button.querySelector('[role="progressbar"]');
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("aria-label")).toBe("Working");
  });

  it("keeps a caller-supplied confirm label as the busy accessible name", async () => {
    await render(true, "Join beta");
    const button = confirmButton();
    expect(accessibleName(button)).toBe("Join beta");
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
