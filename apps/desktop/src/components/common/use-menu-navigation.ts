import { useEffect, useRef, useState } from "react";

export const keyboardMenuSx = {
  '&[data-keyboard-navigation="true"] [role="menuitem"]:hover:not(:focus-visible):not(.Mui-focusVisible), &[data-keyboard-navigation="true"] [role="menuitemcheckbox"]:hover:not(:focus-visible):not(.Mui-focusVisible)':
    {
      backgroundColor: "transparent",
    },
} as const;

const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';

/** Manage focus on the actual menu items, not their visual wrappers. */
export const useMenuNavigation = (
  open: boolean,
  close: () => void,
  focusOnOpen = true,
  back?: () => void,
) => {
  const ref = useRef<HTMLDivElement>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
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
        const first = [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].find(
          (item) => item.getAttribute("aria-disabled") !== "true",
        );
        first?.focus();
        setKeyboardNavigation(Boolean(first?.matches(":focus-visible")));
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
    setKeyboardNavigation(true);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.movementX || event.movementY) setKeyboardNavigation(false);
  };
  return { ref, onKeyDown, onMouseMove, keyboardNavigation };
};
