import { Box } from "@mui/material";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type ContextMenuItem } from "./ContextMenuSurface";
import {
  MENU_OFFSET,
  MENU_MIN_WIDTH,
  MENU_MAX_HEIGHT,
  ITEM_HEIGHT,
  PADDING,
} from "./context-menu.constants";

interface ContextMenuState {
  position: { left: number; top: number };
  items: ContextMenuItem[];
  anchor: { clientX: number; clientY: number };
}

/** The rendered menu, so it never becomes its own restore target. */
const MENU_SELECTOR = '[role="menu"]';

/**
 * Elements that can take focus. A plain `div` reports `tabIndex === -1`, the
 * same value an explicit `tabindex="-1"` reports, so the IDL property cannot
 * tell the two apart and the markup has to. Every wired surface renders its
 * right-click host as a plain `Box component="div"`, and `focus()` on such an
 * element does nothing, so a restore target has to be resolved to something
 * focusable or the restore silently drops the user on `<body>`.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "audio[controls]",
  "button",
  "iframe",
  "input",
  "select",
  "textarea",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

/** Whether `focus()` on `el` would actually move focus. */
const canReceiveFocus = (el: HTMLElement): boolean =>
  el.matches(FOCUSABLE_SELECTOR) &&
  el.isConnected &&
  // `contenteditable="false"` opts a subtree out of the editable host walk
  // and cannot take focus either.
  el.getAttribute("contenteditable") !== "false" &&
  // `input[type=hidden]` matches the selector above but is never focusable.
  !(el instanceof HTMLInputElement && el.type === "hidden") &&
  // `:disabled` also covers a control inside a disabled <fieldset>, which a
  // bare `[disabled]` ancestor lookup would miss.
  !el.matches(":disabled") &&
  // A subtree that is `inert` refuses focus without being disabled itself.
  el.closest("[inert]") === null;

/** `el` when it is a usable restore target, otherwise null. */
const restoreCandidate = (el: Element | null): HTMLElement | null => {
  if (!(el instanceof HTMLElement) || !canReceiveFocus(el)) return null;
  return el.closest(MENU_SELECTOR) ? null : el;
};

/**
 * Whatever held focus before the browser ran the focusing steps for the most
 * recent mousedown anywhere in the document.
 *
 * A `contextmenu` is always preceded by a `mousedown`, and those focusing steps
 * run as the mousedown's default action, which is after every listener. Over a
 * non-focusable area they unfocus the current element, so by the time the menu
 * opens, `document.activeElement` is already `<body>` and reading it there can
 * only ever return nothing. That is the case for the surfaces with no focusable
 * ancestor of their own (`TranscriptRow`, `ChatMessageBubble`), so the value has
 * to be read while that mousedown is still being dispatched, not after.
 *
 * Capture buys that ordering against the other listeners on the event path, not
 * against the default action, which a bubble listener on `document` also
 * precedes. A bubble listener runs after every element handler, so a handler
 * that focuses on mousedown has already moved `document.activeElement` by the
 * time it runs, and the handlers that stop mousedown propagation (`ListTile`'s
 * hover buttons, `MenuPopover`, `ManualStylingRow`, and the model buttons in
 * `AITranscriptionConfiguration`) keep it from running at all, which would leave
 * the previous right-click's value behind. The capture phase is the first stop
 * inside the document and nothing below it can cut it short, so the value is
 * always where the user left it.
 *
 * Module scope on purpose: one listener for the document rather than one per
 * menu instance, because a list renders one menu hook per row.
 */
let focusBeforeMouseDown: HTMLElement | null = null;

if (typeof document !== "undefined") {
  document.addEventListener(
    "mousedown",
    () => {
      focusBeforeMouseDown = restoreCandidate(document.activeElement);
    },
    true,
  );
}

/**
 * Resolve where focus goes back to when the menu closes: the right-clicked
 * element when it can take focus, else the nearest focusable ancestor (a row
 * whose `ListItemButton` wraps the text the user hit), else whatever still
 * holds focus, and finally what held focus before this right-click unfocused
 * it. The menu itself is never a candidate, because a right-click on it would
 * otherwise overwrite the real target with the node the menu already owns.
 */
const resolveRestoreTarget = (
  clicked: EventTarget | null,
): HTMLElement | null => {
  let el: Element | null = clicked instanceof Element ? clicked : null;
  for (; el; el = el.parentElement) {
    const candidate = restoreCandidate(el);
    if (candidate) return candidate;
  }
  // A menu opened from the keyboard, with no mousedown to run focusing steps,
  // leaves the focused element in place, so this is the only way to get at it.
  return (
    restoreCandidate(document.activeElement) ??
    // A right-click on a non-focusable area unfocused everything, so the
    // pre-mousedown capture is what still knows where the user was.
    restoreCandidate(focusBeforeMouseDown)
  );
};

export interface UseContextMenuReturn {
  /**
   * Call this from a surface's `onContextMenu` handler, passing the native
   * event (`e.nativeEvent`). Accepting the native `MouseEvent` (rather than
   * the React synthetic wrapper) keeps the same entry point usable from
   * native DOM listeners such as the provider's global `contextmenu` handler,
   * where a synthetic event does not exist.
   */
  handleContextMenu: (e: MouseEvent, items: ContextMenuItem[]) => void;
  /** Render this in your component tree at the location where the menu should appear. */
  renderMenu: () => React.ReactElement | null;
  /**
   * Close the menu programmatically. Pass `restoreFocus` to return focus to
   * the element the menu took it from (the right-clicked element, the nearest
   * focusable ancestor of it, or the previously focused element; see Escape and
   * Tab handling); omit it for dismissals where the user is intentionally
   * moving focus elsewhere (click-away, scroll, blur).
   */
  closeMenu: (restoreFocus?: boolean) => void;
}

/**
 * Hook that manages context menu open/close state.
 * Handles positioning, click-away, scroll-away, blur, and Escape.
 *
 * Example:
 * ```tsx
 * const ctxMenu = useContextMenu();
 *
 * return (
 *   <div onContextMenu={(e) => ctxMenu.handleContextMenu(e, items)}>
 *     {ctxMenu.renderMenu()}
 *   </div>
 * );
 * ```
 */
export const useContextMenu = (): UseContextMenuReturn => {
  const [state, setState] = useState<ContextMenuState | null>(null);
  // Element that had focus before the menu opened, restored on close so
  // keyboard users keep their place (A11 focus-management requirement). It is
  // resolved to something focusable at open time, because a surface host that
  // cannot take focus would turn every restore into a silent no-op. It can
  // still be null: a surface with no focusable ancestor, right-clicked while
  // nothing held focus, leaves nowhere to go back to.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setState(null);
    // Restore focus only on explicit request (Escape / item activation). A
    // click-away or scroll dismissal must NOT yank focus back — the user is
    // deliberately moving focus elsewhere and calling focus() during their
    // mousedown would defeat their click.
    const previous = previouslyFocusedRef.current;
    if (restoreFocus && previous?.isConnected) {
      previous.focus();
    }
    previouslyFocusedRef.current = null;
  }, []);

  // Position the menu, clamping to viewport
  const computePosition = useCallback(
    (
      e: Pick<MouseEvent, "clientX" | "clientY">,
      menuWidth: number,
      menuHeight: number,
    ) => {
      let left = e.clientX + MENU_OFFSET;
      let top = e.clientY + MENU_OFFSET;

      // Clamp right edge
      if (left + menuWidth > window.innerWidth - PADDING) {
        left = e.clientX - menuWidth - MENU_OFFSET;
      }
      // Clamp bottom edge
      if (top + menuHeight > window.innerHeight - PADDING) {
        top = window.innerHeight - menuHeight - PADDING;
      }
      // Clamp top edge
      if (top < PADDING) {
        top = PADDING;
      }
      // Clamp left edge
      if (left < PADDING) {
        left = PADDING;
      }

      return { left: Math.max(0, left), top: Math.max(0, top) };
    },
    [],
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent, items: ContextMenuItem[]) => {
      // Bail before suppressing the native menu: an empty item list means
      // there is nothing to show, so the default context menu should win.
      if (items.length === 0) return;

      e.preventDefault();
      e.stopPropagation();

      // Record where focus should return to once the menu steals it, so
      // `closeMenu` can put the user back on the surface they acted on.
      // Resolved on every open — including a reopen on a different surface
      // while the menu is already open — and always to an element that can
      // actually take focus, so the restore is never a silent no-op.
      previouslyFocusedRef.current = resolveRestoreTarget(e.target);

      const estimatedHeight = Math.min(
        items.filter((i) => i.kind !== "divider").length * ITEM_HEIGHT +
          items.filter((i) => i.kind === "divider").length * 8,
        MENU_MAX_HEIGHT,
      );
      const estimatedWidth = MENU_MIN_WIDTH;
      const position = computePosition(e, estimatedWidth, estimatedHeight);

      setState({
        position,
        items,
        anchor: { clientX: e.clientX, clientY: e.clientY },
      });
    },
    [computePosition],
  );

  // Estimates are not enough for wrapped labels and small viewports. Measure
  // the rendered surface before paint and clamp using its actual dimensions.
  useLayoutEffect(() => {
    if (!state) return;
    const container = menuContainerRef.current;
    const menu = container?.querySelector<HTMLElement>(MENU_SELECTOR);
    if (!container || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const position = computePosition(state.anchor, width, height);
    container.style.left = `${position.left}px`;
    container.style.top = `${position.top}px`;
  }, [state, computePosition]);

  // Close listeners
  useEffect(() => {
    if (!state) return;

    const handleClickAway = (e: MouseEvent) => {
      // Don't close if clicking inside the menu
      const target = e.target as HTMLElement;
      if (target.closest(MENU_SELECTOR)) return;
      closeMenu(false);
    };

    const handleScroll = (e: Event) => {
      // Scrolling inside a long menu (overflowY: auto) must NOT close it —
      // that's the user navigating the menu itself. Only an external scroll
      // (the page, a parent list) dismisses the menu. The listener is registered
      // on `window` with capture, so `e.target` is whatever scrolled -- and that is
      // not always an Element.
      //
      // Usually it is not. A page-level scroll has `document` as its target, and
      // `Document` has no `closest`, so the previous `target?.closest(MENU_SELECTOR)`
      // threw a TypeError on exactly the event it was written to handle, taking the
      // `closeMenu(false)` below with it: the menu logged an error AND failed to
      // dismiss. The `as HTMLElement` cast is what hid that, so this checks the
      // runtime type instead of asserting one.
      const target = e.target;
      if (target instanceof Element && target.closest(MENU_SELECTOR)) return;
      closeMenu(false);
    };

    const handleBlur = () => {
      closeMenu(false);
    };

    const handleDismissKeys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation: the menu consumes Escape so a
        // wrapping host (MUI dialog, drawer) does not also close.
        e.stopPropagation();
        closeMenu(true);
        return;
      }
      if (e.key === "Tab") {
        // A vertical menu must not cycle focus with Tab, so the key is left
        // alone for the browser to move focus onward. The restore has to
        // happen first: the menu holds the focused node, it is portaled to the
        // end of <body>, and unmounting it without a restore leaves focus on
        // the body, so the browser would then resume from the top of the
        // document. Restoring during the keydown puts the user back on the
        // surface, and the browser's own Tab continues from there. A surface
        // with nothing focusable to restore (a bare `div` host and nothing
        // focused beforehand) resolves to no target at all; there the browser
        // resumes from its own right-click focus starting point, which is the
        // surface the user pointed at.
        closeMenu(true);
      }
    };

    // Use setTimeout to avoid the same click that opened the menu from closing it
    const clickAwayTimer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickAway);
    }, 0);

    // Scroll events queued before opening can arrive in the next frame. Do
    // not mistake those for a new scroll that moved the anchor afterwards.
    const scrollFrame = requestAnimationFrame(() => {
      window.addEventListener("scroll", handleScroll, true);
    });
    window.addEventListener("blur", handleBlur);
    document.addEventListener("keydown", handleDismissKeys, true);

    return () => {
      clearTimeout(clickAwayTimer);
      document.removeEventListener("mousedown", handleClickAway);
      cancelAnimationFrame(scrollFrame);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("keydown", handleDismissKeys, true);
    };
  }, [state, closeMenu]);

  const renderMenu = useCallback(() => {
    if (!state) return null;
    // Wrap each item's onClick so the menu always closes after activation.
    const wrappedItems = state.items.map((item) => {
      if (item.kind === "divider") return item;
      return {
        ...item,
        onClick: () => {
          item.onClick();
          closeMenu(true);
        },
      };
    });
    return createPortal(
      <Box
        ref={menuContainerRef}
        sx={{
          position: "fixed",
          left: state.position.left,
          top: state.position.top,
          zIndex: 1400,
        }}
      >
        <ContextMenu items={wrappedItems} />
      </Box>,
      // Portal to <body>: a transformed/filtered ancestor (Framer Motion
      // route wrappers keep one) would re-anchor `position: fixed` and clip
      // the menu at the overflow boundary.
      document.body,
    );
  }, [state, closeMenu]);

  return { handleContextMenu, renderMenu, closeMenu };
};
