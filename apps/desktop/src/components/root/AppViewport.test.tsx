// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { requireElement } from "../../../test/helpers/dom";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { mountWithTheme } from "../../../test/helpers/render";
import { AppViewport } from "./AppViewport";

ensureUiHarness();

let mounted: ReturnType<typeof mountWithTheme> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("app viewport", () => {
  it("takes the height the 100% chain already gives it", () => {
    mounted = mountWithTheme(
      <AppViewport>
        <main data-route="" />
      </AppViewport>,
    );
    const viewport = requireElement(
      mounted.container.firstElementChild,
      "the viewport",
    );

    // jsdom has no layout, so the computed declaration is the contract:
    // viewport units would be sized as if scrollbars do not exist and would
    // overflow the window once one appears.
    const style = getComputedStyle(viewport);
    expect(style.height).toBe("100%");
    expect(style.width).toBe("100%");
    expect(style.overflow).toBe("hidden");
    expect(mounted.container.querySelector("[data-route]")?.parentElement).toBe(
      viewport,
    );
  });
});
