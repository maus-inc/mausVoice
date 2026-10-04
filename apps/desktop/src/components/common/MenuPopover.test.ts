// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { MenuPopover, type MenuPopoverItem } from "./MenuPopover";

ensureUiHarness();

const Counter = ({ id }: { id: string }) => {
  const [count, setCount] = useState(0);
  return createElement(
    "button",
    {
      "data-item": id,
      onClick: () => setCount((value) => value + 1),
    },
    `${id}: ${count}`,
  );
};

const genericItems = (ids: string[]): MenuPopoverItem[] =>
  ids.map((id) => ({
    id,
    kind: "genericItem",
    builder: () => createElement(Counter, { id }),
  }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const renderMenu = async (items: MenuPopoverItem[]) => {
  await act(async () => {
    root.render(
      createElement(MenuPopover, {
        open: true,
        onClose: vi.fn(),
        anchorReference: "anchorPosition",
        anchorPosition: { top: 0, left: 0 },
        items,
      }),
    );
  });
};

beforeEach(() => {
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("MenuPopover item identity", () => {
  it.each([["new", "a", "b"], ["b", "a"], ["b"]])(
    "preserves each item's state when the order changes to %j",
    async (...ids) => {
      await renderMenu(genericItems(["a", "b"]));
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-item="b"]')?.click();
      });
      await renderMenu(genericItems(ids));
      expect(document.querySelector('[data-item="b"]')?.textContent).toBe(
        "b: 1",
      );
      for (const id of ids.filter((id) => id !== "b")) {
        expect(document.querySelector(`[data-item="${id}"]`)?.textContent).toBe(
          `${id}: 0`,
        );
      }
    },
  );
});
