// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ScrollListPage } from "./ScrollListPage";
ensureUiHarness();

it.each([{ items: [] as string[] }, { items: ["entry"] }])(
  "uses one page heading for a list with items %o",
  ({ items }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          <ScrollListPage
            title="Dictionary"
            subtitle="A description"
            items={items}
            renderItem={(item) => <div>{item}</div>}
          />,
        ),
      );
      expect(host.querySelectorAll("h1")).toHaveLength(1);
      expect(host.querySelector("h1")?.textContent).toBe("Dictionary");
      expect(
        [...host.querySelectorAll("h1,h2,h3,h4,h5,h6")].some(
          (element) => element.textContent === "A description",
        ),
      ).toBe(false);
      expect(
        host.querySelector("h1")?.closest('[aria-hidden="true"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
