// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ScrollListPage } from "./ScrollListPage";
ensureUiHarness();

it("uses auto vertical margins for scrollable empty-state content", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ScrollListPage
          title="Styling"
          items={[]}
          renderItem={() => null}
          emptyState={<div data-empty-state-copy="">How it works</div>}
        />,
      ),
    );

    const emptyStateCopy = host.querySelector("[data-empty-state-copy]");
    const content = emptyStateCopy?.closest(".MuiContainer-root");
    if (!content) throw new Error("Expected the empty-state content container");

    // jsdom cannot measure overflow. Auto margins center the content when it
    // fits and resolve to zero instead of hiding its top when it is too tall.
    const style = getComputedStyle(content);
    expect(style.marginTop).toBe("auto");
    expect(style.marginBottom).toBe("auto");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("emits the short-window scroll and header rules", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ScrollListPage
          title="List"
          items={[1]}
          renderItem={() => <button>Item</button>}
        />,
      ),
    );
    // jsdom cannot evaluate a viewport media query. Check that both rules are
    // emitted together; real-browser checks cover focus and geometry.
    const media = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule &&
          rule.conditionText === "(max-height: 420px)",
      );
    const innerRules = media
      .flatMap((rule) => [...rule.cssRules])
      .map((rule) => rule.cssText);
    expect(
      innerRules.some(
        (rule) =>
          /--p:\s*0\s*!important/.test(rule) &&
          /scroll-padding-bottom:\s*min\(80px,\s*50%\)/.test(rule),
      ),
    ).toBe(true);
    expect(innerRules.some((rule) => /position:\s*relative/.test(rule))).toBe(
      true,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
