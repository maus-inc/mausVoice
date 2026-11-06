// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ScrollListPage } from "./ScrollListPage";
ensureUiHarness();

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
