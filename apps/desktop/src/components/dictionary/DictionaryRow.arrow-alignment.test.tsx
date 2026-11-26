// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Term } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

vi.mock("../../repos", () => ({
  getTermRepo: () => ({ updateTerm: vi.fn(async (term: Term) => term) }),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { DictionaryRow } from "./DictionaryRow";
import { FIELD_CONTROL_HEIGHT } from "./DictionaryTermFields";

ensureUiHarness();

const seedTerm = (overrides: Partial<Term> = {}) => {
  produceAppState((draft) => {
    draft.termById.t = {
      id: "t",
      sourceValue: "before",
      destinationValue: "after",
      isReplacement: true,
      isGlobal: false,
      ...overrides,
    } as Term;
  });
};

const mountRow = async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<DictionaryRow id="t" />));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
};

const arrowAnchor = (host: HTMLElement): HTMLElement => {
  const anchor = host.querySelector<HTMLElement>("[data-dictionary-arrow]");
  if (!anchor) throw new Error("the replacement arrow has no anchored box");
  return anchor;
};

beforeEach(() => {
  document.body.innerHTML = "";
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("DictionaryRow replacement arrow", () => {
  it("anchors the arrow on the fields' control line inside the row", async () => {
    seedTerm();
    const row = await mountRow();
    try {
      const anchor = arrowAnchor(row.host);
      expect(anchor.parentElement?.dataset.dictionaryRow).toBe("t");

      const anchorStyles = getComputedStyle(anchor);
      expect(anchorStyles.display).toBe("flex");
      expect(anchorStyles.alignItems).toBe("center");
      expect(anchorStyles.alignSelf).toBe("flex-start");
      expect(anchorStyles.flexShrink).toBe("0");
      expect(anchorStyles.height).toBe(`${FIELD_CONTROL_HEIGHT}px`);

      const glyph = anchor.querySelector("svg");
      expect(glyph?.getAttribute("class")).toContain("lucide-arrow-right");
      // A top margin is what drifted before: Stack resets the margin of every
      // direct child, so the offset never survived and the arrow rode the top.
      expect(parseFloat(getComputedStyle(glyph!).marginTop)).toBe(0);
    } finally {
      row.unmount();
    }
  });

  it.each([
    { field: "original", selector: 'input[aria-label="Original"]' },
    { field: "replacement", selector: 'textarea[aria-label="Replacement"]' },
  ])(
    "keeps the anchored box when the $field field shows validation text",
    async ({ selector }) => {
      seedTerm();
      const row = await mountRow();
      try {
        const control = row.host.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >(selector)!;
        const setValue = Object.getOwnPropertyDescriptor(
          control instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value",
        )!.set!;
        act(() => control.focus());
        act(() => {
          setValue.call(control, "   ");
          control.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => control.blur());

        expect(control.getAttribute("aria-invalid")).toBe("true");
        expect(
          document.getElementById(control.getAttribute("aria-describedby")!)
            ?.textContent,
        ).toBe("Required. Changes not saved.");

        const anchorStyles = getComputedStyle(arrowAnchor(row.host));
        expect(anchorStyles.alignSelf).toBe("flex-start");
        expect(anchorStyles.height).toBe(`${FIELD_CONTROL_HEIGHT}px`);
      } finally {
        row.unmount();
      }
    },
  );

  it("renders no replacement arrow for a glossary term", async () => {
    seedTerm({ isReplacement: false, destinationValue: "" });
    const row = await mountRow();
    try {
      expect(
        row.host.querySelector('input[aria-label="Glossary term"]'),
      ).not.toBeNull();
      expect(row.host.querySelector("[data-dictionary-arrow]")).toBeNull();
    } finally {
      row.unmount();
    }
  });
});
