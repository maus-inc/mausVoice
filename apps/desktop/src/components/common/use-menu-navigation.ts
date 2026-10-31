import { useEffect, useRef } from "react";

const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';

/** Manage focus on the actual menu items, not their visual wrappers. */
export const useMenuNavigation = (
  open: boolean,
  close: () => void,
  focusOnOpen = true,
  back?: () => void,
) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const frame = requestAnimationFrame(() => {
      const menu = ref.current;
      if (!menu) return;
      const active = document.activeElement;
      // Do not override a user who has already moved to an item or elsewhere.
      if (
        active === document.body ||
        active === menu.parentElement ||
        active === menu
      ) {
        [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)]
          .find((item) => item.getAttribute("aria-disabled") !== "true")
          ?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusOnOpen]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menu = ref.current;
    const active =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(MENU_ITEMS)
        : null;
    if (!menu || !active || event.target !== active || !menu.contains(active))
      return;
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowLeft" && back) {
      event.preventDefault();
      event.stopPropagation();
      back();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].filter(
      (item) => item.getAttribute("aria-disabled") !== "true",
    );
    const index = items.indexOf(active);
    if (index < 0 || !items.length) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  return { ref, onKeyDown };
};
