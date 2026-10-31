// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { MenuPopoverBuilder, type MenuPopoverItem } from "./MenuPopover";

ensureUiHarness();
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const key = async (value: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
    await frame();
  });
const mount = async (items: MenuPopoverItem[]) => {
  setMatchMedia(false);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <MenuPopoverBuilder items={items}>
          {({ ref, open, isOpen }) => (
            <button
              ref={ref}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={open}
            >
              Options
            </button>
          )}
        </MenuPopoverBuilder>
      </MemoryRouter>,
    ),
  );
  const trigger = host.querySelector("button")!;
  await act(async () => {
    trigger.focus();
    trigger.click();
    await frame();
  });
  return {
    trigger,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
};

it("focuses the first actual menu item and navigates without nested interactive roles", async () => {
  const choose = vi.fn();
  const close = vi.fn();
  const items: MenuPopoverItem[] = [
    { id: "a", kind: "listItem", title: "Alpha", onClick: choose },
    { id: "separator", kind: "divider" },
    { id: "b", kind: "listItem", title: "Beta", onClick: choose },
    {
      id: "c",
      kind: "listItem",
      title: "Gamma",
      onClick: ({ close: done }) => {
        close();
        done();
      },
    },
  ];
  const { trigger, cleanup } = await mount(items);
  try {
    const actions = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    expect(actions.map((a) => a.textContent?.slice(0, 5))).toEqual([
      "Alpha",
      "BetaB",
      "Gamma",
    ]);
    expect(actions.every((a) => a.getAttribute("tabindex") === "-1")).toBe(
      true,
    );
    expect(document.activeElement).toBe(actions[0]);
    await key("ArrowUp");
    expect(document.activeElement).toBe(actions[2]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(actions[0]);
    await key("End");
    expect(document.activeElement).toBe(actions[2]);
    await key("Home");
    expect(document.activeElement).toBe(actions[0]);
    await key("ArrowDown");
    expect(document.activeElement).toBe(actions[1]);
    await key("Enter");
    expect(choose).toHaveBeenCalledTimes(1);
    await key("Tab");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  } finally {
    cleanup();
  }
});

it("opens a submenu with the keyboard and returns to its trigger on ArrowLeft", async () => {
  const { cleanup } = await mount([
    {
      id: "group",
      kind: "subMenu",
      title: "More",
      children: [
        { id: "action", kind: "listItem", title: "Action", onClick: vi.fn() },
      ],
    },
  ]);
  try {
    const parent = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(parent);
    await key("ArrowRight");
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
    const action = menus[1].querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(action);
    await key("ArrowLeft");
    expect(document.activeElement).toBe(parent);
  } finally {
    cleanup();
  }
});

it("exposes a checked item and its adjacent action as separate keyboard stops", async () => {
  const edit = vi.fn();
  const { cleanup } = await mount([
    {
      id: "check",
      kind: "listItem",
      title: "Selected style",
      checked: true,
      onClick: vi.fn(),
      endAction: (
        <button
          role="menuitem"
          tabIndex={-1}
          aria-label="Edit style: Selected style"
          onClick={edit}
        >
          Edit
        </button>
      ),
    },
  ]);
  try {
    const checked = document.querySelector<HTMLElement>(
      '[role="menuitemcheckbox"]',
    )!;
    const action = document.querySelector<HTMLElement>(
      '[aria-label="Edit style: Selected style"]',
    )!;
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.contains(action)).toBe(false);
    expect(document.activeElement).toBe(checked);
    await key("ArrowDown");
    expect(document.activeElement).toBe(action);
    await act(async () => action.click());
    expect(edit).toHaveBeenCalledOnce();
  } finally {
    cleanup();
  }
});
