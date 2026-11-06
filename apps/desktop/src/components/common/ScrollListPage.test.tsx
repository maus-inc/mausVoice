// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
vi.mock("react-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-intl")>()),
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
}));
import { ScrollListPage } from "./ScrollListPage";

ensureUiHarness();

describe("ScrollListPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("transitions between empty and populated views and loads more", async () => {
    const loadMore = vi.fn();
    const render = async (items: string[]) => {
      await act(async () => {
        root.render(
          <IntlProvider locale="en">
            <ScrollListPage
              title="Items"
              subtitle="A list"
              action={<button>New</button>}
              items={items}
              renderItem={(item) => <div data-item={item}>{item}</div>}
              computeItemKey={(item) => item}
              emptyState={<p>Nothing here yet</p>}
              hasMore
              onLoadMore={loadMore}
            />
          </IntlProvider>,
        );
      });
    };
    await render([]);
    expect(container.textContent).toContain("Nothing here yet");
    expect(container.querySelectorAll("[data-item]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Show more");

    await render(["one", "two"]);
    expect(container.textContent).not.toContain("Nothing here yet");
    expect(
      [...container.querySelectorAll("[data-item]")].map((n) => n.textContent),
    ).toEqual(["one", "two"]);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Show more",
    );
    expect(more).toBeDefined();
    await act(async () => more!.click());
    expect(loadMore).toHaveBeenCalledOnce();

    await render([]);
    expect(container.textContent).toContain("Nothing here yet");
    expect(container.querySelectorAll("[data-item]")).toHaveLength(0);
  });
});
