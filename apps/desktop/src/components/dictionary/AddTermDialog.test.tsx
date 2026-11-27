// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { AddTermDialog } from "./AddTermDialog";
ensureUiHarness();

const setFieldValue = (
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("preserves switch presentation, term modes, callbacks and reset behavior", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onAddGlossaryTerms = vi.fn();
  const onAddReplacement = vi.fn();
  const renderDialog = (open: boolean) =>
    root.render(
      <AddTermDialog
        open={open}
        onClose={onClose}
        onAddGlossaryTerms={onAddGlossaryTerms}
        onAddReplacement={onAddReplacement}
      />,
    );
  try {
    await act(async () => renderDialog(true));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Add term");
    expect(document.querySelectorAll(`[id="${titleId}"]`)).toHaveLength(1);
    const toggle = dialog.querySelector<HTMLInputElement>('[role="switch"]')!;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.checked).toBe(false);
    act(() => toggle.focus());
    expect(document.activeElement).toBe(toggle);
    expect(
      toggle
        .closest(".MuiSwitch-root")
        ?.classList.contains("MuiSwitch-sizeMedium"),
    ).toBe(true);
    expect(
      document.getElementById(toggle.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("Replacement");
    expect(
      dialog
        .querySelector("textarea:not([aria-hidden])")
        ?.getAttribute("aria-label"),
    ).toBe("Enter a term");

    act(() => toggle.click());
    expect(toggle.checked).toBe(true);
    const replacementFields = [
      ...dialog.querySelectorAll<HTMLInputElement>(
        'input:not([role="switch"])',
      ),
    ];
    expect(
      replacementFields.map((field) => field.getAttribute("aria-label")),
    ).toEqual(["Original term", "Replacement term"]);
    setFieldValue(replacementFields[0], " before ");
    setFieldValue(replacementFields[1], " after ");
    act(() => {
      [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().startsWith("Add"))!
        .click();
    });
    expect(onAddReplacement).toHaveBeenCalledWith("before", "after");
    expect(onAddGlossaryTerms).not.toHaveBeenCalled();

    await act(async () => renderDialog(false));
    await act(async () => renderDialog(true));
    const reopenedDialog =
      document.querySelector<HTMLElement>('[role="dialog"]')!;
    const reopenedToggle =
      reopenedDialog.querySelector<HTMLInputElement>('[role="switch"]')!;
    expect(reopenedToggle.checked).toBe(false);
    const glossaryField = reopenedDialog.querySelector<HTMLTextAreaElement>(
      "textarea:not([aria-hidden])",
    )!;
    expect(glossaryField.getAttribute("aria-label")).toBe("Enter a term");
    setFieldValue(glossaryField, "alpha\n\nbeta");
    act(() => {
      [...reopenedDialog.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().startsWith("Add"))!
        .click();
    });
    expect(onAddGlossaryTerms).toHaveBeenCalledWith(["alpha", "beta"]);
    expect(onClose).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
