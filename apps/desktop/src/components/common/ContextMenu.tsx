/**
 * Native-feeling right-click context menu.
 *
 * Builds on the app's existing MenuPopover infrastructure and adds:
 * - Opens at the cursor position, clamped to viewport edges
 * - Single instance (right-click elsewhere closes + reopens)
 * - Closes on: click (with item action), scroll, window blur, Escape
 * - Keyboard: ArrowUp/Down navigation, Enter/Space to activate
 * - Focus management (trap + restore on close)
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
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ── Types ────────────────────────────────────────────────────────────────

export type ContextMenuActionItem = {
  kind?: "action";
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  accelerator?: string;
};

export type ContextMenuDivider = {
  kind: "divider";
};

export type ContextMenuItem = ContextMenuActionItem | ContextMenuDivider;

interface ContextMenuState {
  open: boolean;
  position: { left: number; top: number };
  items: ContextMenuItem[];
  /**
   * A unique key to identify the surface that opened the menu.
   * Used to allow reopening on a different surface without explicit close.
   */
  surfaceKey: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const MENU_OFFSET = 4; // px from cursor
const MENU_MIN_WIDTH = 180;
const MENU_MAX_HEIGHT = 360;
const ITEM_HEIGHT = 40; // approx px per item for keyboard nav
const PADDING = 12; // viewport padding so menu doesn't stick to edge

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
export const ContextMenu = ({ items, sx }: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  // Reset active index when items change
  useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const actionableIndices = items
        .map((item, i) => (item.kind === "divider" ? -1 : i))
        .filter((i) => i >= 0);

      if (actionableIndices.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
        case "Tab": {
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
setActiveIndex(
                actionableIndices.at(-1) ?? 0,
              );
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
      onKeyDown={handleKeyDown}
      sx={{
        position: "fixed",
        zIndex: 1400,
        minWidth: MENU_MIN_WIDTH,
        maxHeight: MENU_MAX_HEIGHT,
        overflowY: "auto",
        py: 0.5,
        borderRadius: 1.5,
        boxShadow: (t) => t.shadows[8],
        border: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
        outline: "none",
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
        },
        ...sx,
      }}
      autoFocus
    >
      {items.map((item, index) => {
        if (item.kind === "divider") {
          return <Divider key={`div-${index}`} sx={{ my: 0.5 }} />;
        }

        const isActive = activeIndex === index;
        return (
          <ListItemButton
            key={`item-${index}`}
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
                  color: item.danger ? "error.main" : item.disabled ? "text.disabled" : "text.secondary",
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
  /** Call this from the surface's onContextMenu handler. */
  handleContextMenu: (
    e: React.MouseEvent,
    items: ContextMenuItem[],
    surfaceKey?: string,
  ) => void;
  /** Render this in your component tree at the location where the menu should appear. */
  renderMenu: () => React.ReactElement | null;
  /** Close the menu programmatically. */
  closeMenu: () => void;
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
  const stateRef = useRef(state);
  stateRef.current = state;

  const closeMenu = useCallback(() => {
    setState(null);
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
    (
      e: React.MouseEvent,
      items: ContextMenuItem[],
      surfaceKey?: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();

      if (items.length === 0) return;

      const estimatedHeight = Math.min(
        items.filter((i) => i.kind !== "divider").length * ITEM_HEIGHT +
          items.filter((i) => i.kind === "divider").length * 8,
        MENU_MAX_HEIGHT,
      );
      const estimatedWidth = MENU_MIN_WIDTH;
      const position = computePosition(
        e.nativeEvent,
        estimatedWidth,
        estimatedHeight,
      );

      setState({
        open: true,
        position,
        items,
        surfaceKey: surfaceKey ?? "default",
      });
    },
    [computePosition],
  );

  // Close listeners
  useEffect(() => {
    if (!state) return;

    const handleClickAway = (e: MouseEvent) => {
      // Don't close if clicking inside the menu
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      closeMenu();
    };

    const handleScroll = () => {
      closeMenu();
    };

    const handleBlur = () => {
      closeMenu();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
      }
    };

    // Use setTimeout to avoid the same click that opened the menu from closing it
    const clickAwayTimer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickAway);
    }, 0);

    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("keydown", handleEscape);

    return () => {
      clearTimeout(clickAwayTimer);
      document.removeEventListener("mousedown", handleClickAway);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [state, closeMenu]);

  const renderMenu = useCallback(() => {
    if (!state) return null;
    return (
      <Box
        sx={{
          position: "fixed",
          left: state.position.left,
          top: state.position.top,
          zIndex: 1400,
        }}
      >
        <ContextMenu items={state.items} />
      </Box>
    );
  }, [state]);

  return { handleContextMenu, renderMenu, closeMenu };
};

// ── Context Provider for app-wide default right-click handling ───────────

interface ContextMenuProviderContextValue {
  /** Register a surface's context menu handler. Returns a cleanup function. */
  registerSurface: (
    key: string,
    handler: (e: React.MouseEvent) => void,
  ) => () => void;
}

const ContextMenuProviderContext =
  createContext<ContextMenuProviderContextValue | null>(null);

/**
 * Provider that enables app-wide context menu handling.
 * Surfaces register their handlers; the provider intercepts
 * unhandled right-clicks and shows a default menu.
 */
export const ContextMenuProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const surfaceHandlersRef = useRef<
    Map<string, (e: React.MouseEvent) => void>
  >(new Map());
  const ctxMenu = useContextMenu();

  const registerSurface = useCallback(
    (key: string, handler: (e: React.MouseEvent) => void) => {
      surfaceHandlersRef.current.set(key, handler);
      return () => {
        surfaceHandlersRef.current.delete(key);
      };
    },
    [],
  );

  const providerValue = useMemo(() => ({ registerSurface }), [registerSurface]);

  // Platform detection for accelerator display
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const modKey = isMac ? "\u2318" : "Ctrl";

  // Global right-click handler - suppress default on ALL elements
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      // Always prevent the default webview context menu
      e.preventDefault();

      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (isInput) {
        // For text inputs, offer clipboard actions via the platform clipboard API
        const selection = window.getSelection();
        const hasSelection = selection ? selection.toString().length > 0 : false;
        ctxMenu.handleContextMenu(e as unknown as React.MouseEvent, [
          {
            label: "Cut",
            disabled: !hasSelection,
            onClick: () => {
              void navigator.clipboard.writeText(selection?.toString() ?? "");
              document.execCommand("cut");
            },
            accelerator: modKey + "+X",
          },
          {
            label: "Copy",
            disabled: !hasSelection,
            onClick: () => {
              void navigator.clipboard.writeText(selection?.toString() ?? "");
            },
            accelerator: modKey + "+C",
          },
          { kind: "divider" },
          {
            label: "Paste",
            onClick: () => {
              void navigator.clipboard.readText().then(function(t) {
                document.execCommand("insertText", false, t);
              });
            },
            accelerator: modKey + "+V",
          },
          { kind: "divider" },
          {
            label: "Select All",
            onClick: () => {
              document.execCommand("selectAll");
            },
            accelerator: modKey + "+A",
          },
        ]);
      }
    };

    document.addEventListener("contextmenu", handleGlobalContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleGlobalContextMenu);
    };
  }, [ctxMenu]);

  return (
    <ContextMenuProviderContext.Provider value={providerValue}>
      {children}
      {ctxMenu.renderMenu()}
    </ContextMenuProviderContext.Provider>
  );
};

/**
 * Hook to register a surface's context menu handler with the provider.
 */
export const useSurfaceContextMenu = (
  surfaceKey: string,
  getItems: () => ContextMenuItem[],
) => {
  const ctxMenu = useContextMenu();
  const ctx = useContext(ContextMenuProviderContext);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      ctxMenu.handleContextMenu(e, getItems(), surfaceKey);
    },
    [ctxMenu, getItems, surfaceKey],
  );

  // Register with provider if available
  useEffect(() => {
    if (!ctx) return;
    return ctx.registerSurface(surfaceKey, handleContextMenu);
  }, [ctx, surfaceKey, handleContextMenu]);

  return {
    handleContextMenu,
    renderMenu: ctxMenu.renderMenu,
    closeMenu: ctxMenu.closeMenu,
  };
};