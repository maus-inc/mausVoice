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
import { useCallback, useEffect, useRef, useState } from "react";
import { hairline, premiumSurface } from "../../styles/shadows";
import {
  ITEM_HEIGHT,
  MENU_MAX_HEIGHT,
  MENU_MIN_WIDTH,
} from "./context-menu.constants";

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
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const revealKeyboardItem = useRef(false);

  // Reset active index when items change
  useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Focus the menu on open so keyboard navigation (arrows/Enter) works.
  // Focus explicitly after the portal commits, not via a DOM autoFocus prop.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (activeIndex < 0 || !revealKeyboardItem.current) return;
    revealKeyboardItem.current = false;
    const menu = menuRef.current;
    const item = menu?.querySelector<HTMLElement>(
      `#context-menu-item-${activeIndex}`,
    );
    if (!menu || !item) return;
    const menuRect = menu.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < menuRect.top)
      menu.scrollTop -= menuRect.top - itemRect.top;
    else if (itemRect.bottom > menuRect.bottom)
      menu.scrollTop += itemRect.bottom - menuRect.bottom;
  }, [activeIndex]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const actionableIndices = items
        .map((item, i) => (item.kind === "divider" || item.disabled ? -1 : i))
        .filter((i) => i >= 0);

      if (actionableIndices.length === 0) return;

      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        revealKeyboardItem.current = true;
        setKeyboardNavigation(true);
      }
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
        default:
          // Any other key (Tab, printable characters, Escape — handled on
          // document in capture phase) is not the menu's to act on.
          break;
      }
    },
    [items, activeIndex],
  );

  return (
    <Paper
      ref={menuRef}
      role="menu"
      data-keyboard-navigation={keyboardNavigation}
      tabIndex={-1}
      aria-activedescendant={
        activeIndex >= 0 ? `context-menu-item-${activeIndex}` : undefined
      }
      onKeyDown={handleKeyDown}
      sx={[
        (theme) => ({
          position: "fixed",
          zIndex: 1400,
          minWidth: `min(${MENU_MIN_WIDTH}px, calc(100vw - 24px))`,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: `min(${MENU_MAX_HEIGHT}px, calc(100dvh - 24px))`,
          overflowY: "auto",
          py: 0.5,
          borderRadius: 1.5,
          boxShadow: premiumSurface.light.hover,
          border: hairline.light(),
          backgroundColor: "background.paper",
          outline: "none",
          '&[data-keyboard-navigation="true"] [role="menuitem"]:hover:not(.Mui-selected)':
            {
              backgroundColor: "transparent",
            },
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
          // NOSONAR: a divider carries no identity — `ContextMenuDivider` is
          // only `{ kind: "divider" }`, so there is no stable id to key on and
          // any substitute would be as unstable as the index. The index is
          // safe here because the array is fixed for the menu's lifetime:
          // `renderMenu` returns null when closed (so the list unmounts between
          // opens), `state.items` is only ever replaced wholesale by
          // `handleContextMenu`, every action row's key also embeds its label,
          // and `activeIndex` — the only state keyed by position — is reset to
          // -1 by the effect above whenever `items` changes identity.
          //
          // This sits on the line ABOVE the keyed element, not up at the top of
          // the block. `deepsource-disable-next-line` suppresses the line that
          // FOLLOWS the comment, so placed at the top of the `if` it would
          // suppress a comment and leave the real finding reported.
          // deepsource-disable-next-line JS-0437
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
            onMouseEnter={() => {
              if (!keyboardNavigation) {
                revealKeyboardItem.current = false;
                setActiveIndex(index);
              }
            }}
            onMouseMove={(event) => {
              if (!event.movementX && !event.movementY) return;
              revealKeyboardItem.current = false;
              setKeyboardNavigation(false);
              setActiveIndex(index);
            }}
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
