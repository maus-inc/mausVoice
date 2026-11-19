// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Term } from "@maus-inc/types";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  updateTerm: vi.fn(async (term: Term) => term),
}));
vi.mock("../../repos", () => ({
  getTermRepo: () => ({ updateTerm: mocks.updateTerm }),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { DictionaryRow } from "./DictionaryRow";
ensureUiHarness();

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.updateTerm.mockClear();
});

it.each(["original", "replacement"])(
  "does not persist a blank %s and saves again after correction",
  async (field) => {
    produceAppState((draft) => {
      draft.termById.t = {
        id: "t",
        sourceValue: "before",
        destinationValue: "after",
        isReplacement: true,
        isGlobal: false,
      } as Term;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<DictionaryRow id="t" />));
      const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        field === "original"
          ? 'input[aria-label="Original"]'
          : 'textarea[aria-label="Replacement"]',
      )!;
      const change = (value: string) => {
        const proto =
          input instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
        act(() => {
          set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      act(() => input.focus());
      change("  ");
      await act(async () => input.blur());
      expect(mocks.updateTerm).not.toHaveBeenCalled();
      expect(getAppState().termById.t.sourceValue).toBe("before");
      expect(getAppState().termById.t.destinationValue).toBe("after");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const description = input.getAttribute("aria-describedby")!;
      expect(document.getElementById(description)?.textContent).toBe(
        "Required. Changes not saved.",
      );
      act(() => input.focus());
      change("fixed");
      await act(async () => input.blur());
      expect(mocks.updateTerm).toHaveBeenCalledTimes(1);
      expect(
        getAppState().termById.t[
          field === "original" ? "sourceValue" : "destinationValue"
        ],
      ).toBe("fixed");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it("permits glossary entries without a replacement", async () => {
  produceAppState((draft) => {
    draft.termById.t = {
      id: "t",
      sourceValue: "before",
      destinationValue: "",
      isReplacement: false,
      isGlobal: false,
    } as Term;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DictionaryRow id="t" />));
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Glossary term"]',
    )!;
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "updated");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    expect(mocks.updateTerm).toHaveBeenCalledTimes(1);
    expect(getAppState().termById.t.sourceValue).toBe("updated");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
