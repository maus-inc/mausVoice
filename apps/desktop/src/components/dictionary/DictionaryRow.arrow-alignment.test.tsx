// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
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
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
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

/**
 * Mounts the row under the application theme, runs the assertions, and
 * unmounts even when one throws. The theme matters here: it is what resolves
 * the body text size and line box the assertions compare against.
 */
const withRow = async (run: (host: HTMLElement) => void | Promise<void>) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        <DictionaryRow id="t" />
      </ThemeProvider>,
    ),
  );
  try {
    await run(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
};

const arrowAnchor = (host: HTMLElement): HTMLElement => {
  const anchor = host.querySelector<HTMLElement>("[data-dictionary-arrow]");
  if (!anchor) throw new Error("the replacement arrow has no anchored box");
  return anchor;
};

const replaceValue = (
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  act(() => control.focus());
  act(() => {
    setValue.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  document.body.innerHTML = "";
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("DictionaryRow replacement arrow", () => {
  it("anchors the arrow on the fields' control line inside the row", async () => {
    seedTerm();
    await withRow((host) => {
      const anchor = arrowAnchor(host);
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

      // The constant must also match the control box the page resolves, so
      // changing it alone fails here and not only in the browser measurement.
      // Only the original field can be derived this way: the replacement's
      // padding sits on its wrapper, which jsdom gives no layout. The browser
      // measurement covers both lines, and it measures the replacement's box
      // as the taller of the two.
      const control = getComputedStyle(
        host.querySelector<HTMLInputElement>('input[aria-label="Original"]')!,
      );
      const controlBox =
        parseFloat(control.lineHeight) +
        parseFloat(control.paddingTop) +
        parseFloat(control.paddingBottom);
      expect(
        Math.abs(parseFloat(anchorStyles.height) - controlBox),
      ).toBeLessThan(2);
    });
  });

  it.each([
    { field: "original", selector: 'input[aria-label="Original"]' },
    { field: "replacement", selector: 'textarea[aria-label="Replacement"]' },
  ])(
    "keeps the anchored box when the $field field shows validation text",
    async ({ selector }) => {
      seedTerm();
      await withRow(async (host) => {
        const control = host.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >(selector)!;
        replaceValue(control, "   ");
        await act(async () => control.blur());

        expect(control.getAttribute("aria-invalid")).toBe("true");
        expect(
          document.getElementById(control.getAttribute("aria-describedby")!)
            ?.textContent,
        ).toBe("Required. Changes not saved.");

        const anchorStyles = getComputedStyle(arrowAnchor(host));
        expect(anchorStyles.alignSelf).toBe("flex-start");
        expect(anchorStyles.height).toBe(`${FIELD_CONTROL_HEIGHT}px`);
      });
    },
  );

  it("renders no replacement arrow for a glossary term", async () => {
    seedTerm({ isReplacement: false, destinationValue: "" });
    await withRow((host) => {
      expect(
        host.querySelector('input[aria-label="Glossary term"]'),
      ).not.toBeNull();
      expect(host.querySelector("[data-dictionary-arrow]")).toBeNull();
    });
  });
});
