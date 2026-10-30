import { act } from "react";

export const openContextMenu = (container: HTMLElement): Element | null => {
  const row = container.querySelector<HTMLElement>("div");
  if (!row) throw new Error("Expected a rendered row before opening its menu");
  act(() => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
      }),
    );
  });
  return document.querySelector('[role="menu"]');
};

export const menuLabels = (menu: Element | null): string[] =>
  Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map(
    (item) => item.textContent ?? "",
  );
