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

it("names the dialog, replacement switch and both types of term field", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AddTermDialog
          open
          onClose={() => {}}
          onAddGlossaryTerms={() => {}}
          onAddReplacement={() => {}}
        />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Add term");
    expect(document.querySelectorAll(`[id="${titleId}"]`)).toHaveLength(1);
    const toggle = dialog.querySelector<HTMLInputElement>('[role="switch"]')!;
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
    expect(
      [...dialog.querySelectorAll('input:not([role="switch"])')].map((input) =>
        input.getAttribute("aria-label"),
      ),
    ).toEqual(["Original term", "Replacement term"]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
