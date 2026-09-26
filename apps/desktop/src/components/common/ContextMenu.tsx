/**
 * Native-feeling right-click context menu.
 *
 * Builds on the app's existing MenuPopover infrastructure and adds:
 * - Opens at the cursor position, clamped to viewport edges
 * - Single instance (right-click elsewhere closes + reopens)
 * - Closes on: click (with item action), scroll, window blur, Escape
 * - Keyboard: ArrowUp/Down navigation, Enter/Space to activate
 * - Focus management (focus on open, restore on Escape or explicit close)
 * - Dark/light theming from MUI palette
 *
 * Usage:
 * ```tsx
 * const items: ContextMenuItem[] = [
 *   { label: "Copy", icon: <CopyIcon />, onClick: () => ... },
 *   { kind: "divider" },
 *   { label: "Delete", icon: <DeleteIcon />, onClick: () => ..., danger: true },
 * ];
 *
 * <div onContextMenu={(e) => handleContextMenu(e, items)}>
 *   Right-click me
 * </div>
 * ```
 *
 * Or use the context provider for app-wide default menu handling:
 * ```tsx
 * <ContextMenuProvider>
 *   <YourApp />
 * </ContextMenuProvider>
 * ```
 */

import {
  Box,
  Divider,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  type SxProps,
  type Theme,
} from "@mui/material";
import {
  ClipboardCopy,
  ClipboardPaste,
  Scissors,
  SquareDashedMousePointer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { hairline, premiumSurface } from "../../styles/shadows";

// ── Types ────────────────────────────────────────────────────────────────

export type ContextMenuActionItem = {
  kind?: "action";
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  accelerator?: string;
};

export type ContextMenuDivider = {
  kind: "divider";
};

export type ContextMenuItem = ContextMenuActionItem | ContextMenuDivider;

interface ContextMenuState {
  position: { left: number; top: number };
  items: ContextMenuItem[];
}

// ── Constants ────────────────────────────────────────────────────────────

const MENU_OFFSET = 4; // px from cursor
const MENU_MIN_WIDTH = 180;
const MENU_MAX_HEIGHT = 360;
const ITEM_HEIGHT = 40; // approx px per item for keyboard nav
const PADDING = 12; // viewport padding so menu doesn't stick to edge

// ── Editable-target helpers (clipboard menu) ─────────────────────────────

/**
 * The editable element a right-click acted on, plus its captured selection.
 * Captured at `contextmenu` time because the menu's `autoFocus` steals focus,
 * and `window.getSelection()` does NOT reflect `<input>`/`<textarea>`
 * selections (those live in `selectionStart`/`selectionEnd`).
 */
type EditableTarget = {
  el: HTMLElement;
  /** Selected text ("" when nothing selected). */
  text: string;
  /** Input/textarea selection bounds (only meaningful for inputs). */
  start: number;
  end: number;
  /** contenteditable selection snapshot (null for inputs). */
  range: Range | null;
};

const isTextInput = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  el.tagName === "INPUT" || el.tagName === "TEXTAREA";

/** Snapshot the current selection for a contenteditable element. */
const contentEditableSelection = (): { text: string; range: Range | null } => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { text: "", range: null };
  return { text: sel.toString(), range: sel.getRangeAt(0).cloneRange() };
};

/**
 * Return the owning contenteditable host for `target`. An explicit nested
 * `contenteditable="false"` is a boundary: it must not inherit the outer
 * editor's clipboard menu.
 */
const getContentEditableHost = (target: HTMLElement): HTMLElement | null => {
  for (
    let current: HTMLElement | null = target;
    current;
    current = current.parentElement
  ) {
    const value = current.getAttribute("contenteditable");
    if (value === "false") return null;
    if (value === "" || value === "true") return current;
  }
  return null;
};

/** Whether an event target belongs to a user-editable control. */
export const isEditableEventTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (isTextInput(target) || getContentEditableHost(target) !== null);

/**
 * Resolve the editable root for a right-click target. Returns null when the
 * click is not on (or inside) an editable surface.
 */
const resolveEditableTarget = (target: HTMLElement): EditableTarget | null => {
  if (isTextInput(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return {
      el: target,
      text: target.value.slice(start, end),
      start,
      end,
      range: null,
    };
  }

  const host = getContentEditableHost(target);
  if (!host) return null;
  const selection = contentEditableSelection();
  return {
    el: host,
    text: selection.text,
    start: -1,
    end: -1,
    range: selection.range,
  };
};

/**
 * True when the right-click target is, or is inside, an editable surface
 * (input/textarea/contenteditable). Surfaces use this to yield those
 * right-clicks to the provider's clipboard menu (Cut/Copy/Paste/Select All)
 * instead of showing their own row/context menu.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  return (
    target instanceof HTMLElement && resolveEditableTarget(target) !== null
  );
};

/** Focus the editable and restore its selection so clipboard commands act on it. */
const focusEditable = (t: EditableTarget): void => {
  t.el.focus();
  if (isTextInput(t.el)) {
    if (t.start >= 0) t.el.setSelectionRange(t.start, t.end);
    return;
  }
  if (t.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(t.range);
  }
};

// ── Focus-restore helpers ────────────────────────────────────────────────

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
 * ancestor of their own (`TranscriptRow`, `ChatMessageBubble`), so the value
 * has to be taken in the capture phase, which runs before the default action.
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

// ── Component ────────────────────────────────────────────────────────────

interface ContextMenuProps {
  items: ContextMenuItem[];
  /** Pass through for adding styling */
  sx?: SxProps<Theme>;
}

/**
 * A controlled context menu that renders at the given position.
 * Use `onContextMenu` handler on your surface to set position + items.
 *
 * For convenience, the `useContextMenu` hook wraps the state management.
 */
const iconColor = (item: ContextMenuItem): string => {
  if (item.kind === "divider") return "text.secondary";
  if (item.danger) return "error.main";
  if (item.disabled) return "text.disabled";
  return "text.secondary";
};

export const ContextMenu = ({ items, sx }: ContextMenuProps) => {
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const menuRef = useRef<HTMLDivElement>(null);

  // Reset active index when items change
  useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Focus the menu on open so keyboard navigation (arrows/Enter) works.
  // Focus explicitly after the portal commits, not via a DOM autoFocus prop.
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const actionableIndices = items
        .map((item, i) => (item.kind === "divider" || item.disabled ? -1 : i))
        .filter((i) => i >= 0);

      if (actionableIndices.length === 0) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const currentPos = actionableIndices.indexOf(activeIndex);
          const nextPos = (currentPos + 1) % actionableIndices.length;
          setActiveIndex(actionableIndices[nextPos]);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const currentPos = actionableIndices.indexOf(activeIndex);
          const prevPos =
            (currentPos - 1 + actionableIndices.length) %
            actionableIndices.length;
          setActiveIndex(actionableIndices[prevPos]);
          break;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          if (activeIndex >= 0) {
            const item = items[activeIndex];
            if (item.kind !== "divider" && !item.disabled) {
              item.onClick();
            }
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          if (actionableIndices.length > 0) {
            setActiveIndex(actionableIndices[0]);
          }
          break;
        }
        case "End": {
          e.preventDefault();
          if (actionableIndices.length > 0) {
            setActiveIndex(actionableIndices.at(-1) ?? 0);
          }
          break;
        }
      }
    },
    [items, activeIndex],
  );

  return (
    <Paper
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-activedescendant={
        activeIndex >= 0 ? `context-menu-item-${activeIndex}` : undefined
      }
      onKeyDown={handleKeyDown}
      sx={[
        (theme) => ({
          position: "fixed",
          zIndex: 1400,
          minWidth: MENU_MIN_WIDTH,
          maxHeight: MENU_MAX_HEIGHT,
          overflowY: "auto",
          py: 0.5,
          borderRadius: 1.5,
          boxShadow: premiumSurface.light.hover,
          border: hairline.light(),
          backgroundColor: "background.paper",
          outline: "none",
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
          },
          ...theme.applyStyles("dark", {
            boxShadow: premiumSurface.dark.hover,
            border: hairline.dark(),
          }),
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {items.map((item, index) => {
        if (item.kind === "divider") {
          // NOSONAR: a divider carries no identity — the array is rebuilt
          // per open and never reordered, so the index is stable for the
          // menu's lifetime.
          return <Divider key={"divider-" + index} sx={{ my: 0.5 }} />;
        }

        // Index-prefixed keys stay unique even when two items share a label.
        const itemKey =
          "item-" +
          index +
          "-" +
          (typeof item.label === "string" ? item.label : "");
        const isActive = activeIndex === index;
        return (
          <ListItemButton
            id={`context-menu-item-${index}`}
            key={itemKey}
            role="menuitem"
            disabled={item.disabled}
            selected={isActive}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
              }
            }}
            onMouseEnter={() => setActiveIndex(index)}
            sx={{
              px: 2,
              minHeight: ITEM_HEIGHT,
              color: item.danger ? "error.main" : "text.primary",
              "&.Mui-disabled": {
                opacity: 0.4,
              },
            }}
          >
            {item.icon && (
              <ListItemIcon
                sx={{
                  minWidth: 32,
                  color: iconColor(item),
                }}
              >
                {item.icon}
              </ListItemIcon>
            )}
            <ListItemText
              primary={item.label}
              slotProps={{
                primary: {
                  variant: "body2",
                  noWrap: true,
                },
              }}
            />
            {item.accelerator && (
              <Box
                component="span"
                sx={{
                  ml: 4,
                  fontSize: "0.75rem",
                  color: "text.disabled",
                  letterSpacing: "0.02em",
                }}
              >
                {item.accelerator}
              </Box>
            )}
          </ListItemButton>
        );
      })}
    </Paper>
  );
};

// ── Hook for managing context menu state ─────────────────────────────────

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
    (e: MouseEvent, menuWidth: number, menuHeight: number) => {
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

      setState({ position, items });
    },
    [computePosition],
  );

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
      // (the page, a parent list) dismisses the menu. The scroll listener is
      // registered with capture, so `e.target` is the scrolled element.
      const target = e.target as HTMLElement | null;
      if (target?.closest(MENU_SELECTOR)) return;
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

    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("keydown", handleDismissKeys, true);

    return () => {
      clearTimeout(clickAwayTimer);
      document.removeEventListener("mousedown", handleClickAway);
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

// ── Context Provider for app-wide default right-click handling ───────────

/**
 * Provider that owns the app-wide context-menu instance. Surfaces render their
 * own menus through `useContextMenu()`; this provider additionally handles
 * right-clicks on editable surfaces (inputs/textareas/contenteditable) by
 * showing a localized clipboard menu (Cut/Copy/Paste/Select All). Non-editable
 * right-clicks are left to the platform's native menu.
 */
export const ContextMenuProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const ctxMenu = useContextMenu();
  const intl = useIntl();

  // Platform detection for accelerator display. `navigator.platform` is
  // deprecated; prefer `userAgentData` where available (a newer, not-yet-typed
  // API) and fall back to the legacy property.
  const userAgentDataPlatform =
    typeof navigator !== "undefined"
      ? (
          navigator as Navigator & {
            userAgentData?: { platform: string };
          }
        ).userAgentData?.platform
      : undefined;
  const isMac =
    typeof userAgentDataPlatform === "string"
      ? /mac/i.test(userAgentDataPlatform)
      : typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const modKey = isMac ? "\u2318" : "Ctrl";

  // Global right-click handler - suppress default on ALL elements
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const editable = resolveEditableTarget(target);
      if (!editable) return;

      // Suppress the default webview menu only where we have a real menu to
      // show (clipboard actions). Elsewhere we keep the native menu — an
      // empty custom menu is worse than the platform default.
      e.preventDefault();

      const hasSelection = editable.text.length > 0;
      const copySelection = () => {
        // `writeText` can reject (permission denied in some webviews); swallow
        // it rather than surface an unhandled rejection.
        void navigator.clipboard
          .writeText(editable.text)
          .catch(() => undefined);
      };

      ctxMenu.handleContextMenu(e, [
        {
          label: intl.formatMessage({ defaultMessage: "Cut" }),
          icon: <Scissors size={16} strokeWidth={1.9} />,
          disabled: !hasSelection,
          onClick: () => {
            // Restore focus + selection to the editable so the native cut
            // operates on it, not on the (auto-focused) menu.
            focusEditable(editable);
            document.execCommand("cut"); // NOSONAR: no non-deprecated API for Cut
            copySelection();
          },
          accelerator: modKey + "+X",
        },
        {
          label: intl.formatMessage({ defaultMessage: "Copy" }),
          icon: <ClipboardCopy size={16} strokeWidth={1.9} />,
          disabled: !hasSelection,
          onClick: copySelection,
          accelerator: modKey + "+C",
        },
        { kind: "divider" },
        {
          label: intl.formatMessage({ defaultMessage: "Paste" }),
          icon: <ClipboardPaste size={16} strokeWidth={1.9} />,
          onClick: () => {
            // `readText` can reject (permission denied / no clipboard access);
            // swallow it rather than surface an unhandled rejection.
            void navigator.clipboard
              .readText()
              .then((text) => {
                focusEditable(editable);
                document.execCommand("insertText", false, text); // NOSONAR: no non-deprecated paste API
              })
              .catch(() => undefined);
          },
          accelerator: modKey + "+V",
        },
        { kind: "divider" },
        {
          label: intl.formatMessage({ defaultMessage: "Select All" }),
          icon: <SquareDashedMousePointer size={16} strokeWidth={1.9} />,
          onClick: () => {
            focusEditable(editable);
            if (isTextInput(editable.el)) {
              editable.el.select();
            } else {
              document.execCommand("selectAll"); // NOSONAR: no non-deprecated API for Select All
            }
          },
          accelerator: modKey + "+A",
        },
      ]);
    };

    document.addEventListener("contextmenu", handleGlobalContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleGlobalContextMenu);
    };
  }, [ctxMenu, intl]);

  return (
    <>
      {children}
      {ctxMenu.renderMenu()}
    </>
  );
};
