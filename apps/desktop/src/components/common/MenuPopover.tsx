import {
  Box,
  Divider,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  type PopoverOrigin,
  type PopoverPosition,
  type PopoverReference,
  Stack,
  type SxProps,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { chromeMenuPaperSx } from "./chromeMenu";
import { ListTile } from "./ListTile";
import { keyboardMenuSx, useMenuNavigation } from "./use-menu-navigation";

export type MenuPopoverCallbackArgs = {
  close: () => void;
  event: React.MouseEvent<HTMLElement>;
};

export type MenuPopoverListItem = {
  id: string;
  kind: "listItem";
  title?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** A separate focusable action alongside the primary menu item. */
  endAction?: React.ReactNode;
  checked?: boolean;
  onClick?: (args: MenuPopoverCallbackArgs) => void;
};

export type MenuPopoverDivider = {
  id: string;
  kind: "divider";
};

export type MenuPopoverGenericItem = {
  id: string;
  kind: "genericItem";
  builder: (args: { close: () => void }) => React.ReactNode;
};

export type MenuPopoverSubMenu = {
  id: string;
  kind: "subMenu";
  title?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  children: MenuPopoverItem[];
};

export type MenuPopoverItem =
  | MenuPopoverListItem
  | MenuPopoverDivider
  | MenuPopoverGenericItem
  | MenuPopoverSubMenu;

type MenuPopoverItemRendProps = {
  item: MenuPopoverItem;
  close: () => void;
};

type MenuPopoverSubMenuItemProps = {
  item: MenuPopoverSubMenu;
  close: () => void;
};

function MenuPopoverSubMenuItem({
  item,
  close,
}: Readonly<MenuPopoverSubMenuItemProps>) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  const menuNavigation = useMenuNavigation(
    submenuOpen,
    close,
    keyboardOpen,
    () => {
      setSubmenuOpen(false);
      setKeyboardOpen(false);
    },
  );

  const openSubmenu = (keyboard = false): void => {
    if (keyboard) setKeyboardOpen(true);
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setSubmenuOpen(true);
  };

  const closeSubmenu = (): void => {
    hideTimerRef.current = window.setTimeout(() => {
      setSubmenuOpen(false);
      setKeyboardOpen(false);
    }, 80);
  };

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      <div
        ref={buttonRef}
        onMouseEnter={() => openSubmenu()}
        onMouseLeave={closeSubmenu}
      >
        <ListItemButton
          role="menuitem"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          onClick={(event) => openSubmenu(event.detail === 0)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === " " ||
              event.key === "ArrowRight"
            ) {
              event.preventDefault();
              openSubmenu(true);
            }
          }}
        >
          {item.leading && <ListItemIcon>{item.leading}</ListItemIcon>}
          <ListItemText primary={item.title} />
          {item.trailing}
        </ListItemButton>
      </div>
      <Popover
        open={submenuOpen}
        anchorEl={buttonRef.current}
        onClose={() => {
          setSubmenuOpen(false);
          setKeyboardOpen(false);
        }}
        disableAutoFocus={!keyboardOpen}
        disableEnforceFocus={!keyboardOpen}
        disableRestoreFocus={!keyboardOpen}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            onMouseEnter: () => openSubmenu(),
            onMouseLeave: closeSubmenu,
            sx: chromeMenuPaperSx,
          },
        }}
      >
        <Stack
          role="menu"
          ref={menuNavigation.ref}
          data-keyboard-navigation={menuNavigation.keyboardNavigation}
          onKeyDown={menuNavigation.onKeyDown}
          onMouseMove={menuNavigation.onMouseMove}
          sx={keyboardMenuSx}
        >
          {item.children.map((child) => (
            <Box key={child.id}>
              <MenuPopoverItemRend item={child} close={close} />
            </Box>
          ))}
        </Stack>
      </Popover>
    </>
  );
}

function MenuPopoverItemRend({
  item,
  close,
}: Readonly<MenuPopoverItemRendProps>): React.ReactNode {
  if (item.kind === "listItem") {
    const tile = (
      <ListTile
        itemRole={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        ariaChecked={item.checked}
        leading={item.leading}
        title={item.title}
        trailing={item.trailing}
        onClick={(e) => item.onClick && item.onClick({ close, event: e })}
        sx={
          item.endAction ? { flex: 1, minWidth: 0, width: "auto" } : undefined
        }
      />
    );
    return item.endAction ? (
      <Stack direction="row" sx={{ alignItems: "center" }}>
        {tile}
        {item.endAction}
      </Stack>
    ) : (
      tile
    );
  }

  if (item.kind === "divider") {
    return <Divider />;
  }

  if (item.kind === "genericItem") {
    return item.builder({ close });
  }

  if (item.kind === "subMenu") {
    return <MenuPopoverSubMenuItem item={item} close={close} />;
  }

  return null;
}

type MenuPopoverProps = {
  open: boolean;
  anchorEl?: HTMLElement | null;
  onClose: () => void;
  items: MenuPopoverItem[];
  sx?: SxProps;
  anchorOrigin?: PopoverOrigin;
  transformOrigin?: PopoverOrigin;
  anchorReference?: PopoverReference;
  anchorPosition?: PopoverPosition;
};

type SharedProps = Omit<MenuPopoverProps, "open" | "anchorEl" | "onClose">;

export const MenuPopover = ({
  open,
  anchorEl,
  onClose,
  items,
  sx,
  anchorOrigin,
  transformOrigin,
  ...rest
}: MenuPopoverProps) => {
  const menuNavigation = useMenuNavigation(open, onClose);
  const handleClose = (event: React.MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
    onClose?.();
  };

  const stopPropagation = (event: React.MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={handleClose}
      onMouseDown={stopPropagation}
      anchorOrigin={
        anchorOrigin ?? {
          vertical: "bottom",
          horizontal: "center",
        }
      }
      transformOrigin={
        transformOrigin ?? {
          vertical: "top",
          horizontal: "center",
        }
      }
      slotProps={{
        paper: { sx: chromeMenuPaperSx },
      }}
      {...rest}
    >
      <Stack
        sx={[...(Array.isArray(sx) ? sx : [sx ?? {}]), keyboardMenuSx]}
        role="menu"
        ref={menuNavigation.ref}
        data-keyboard-navigation={menuNavigation.keyboardNavigation}
        onKeyDown={menuNavigation.onKeyDown}
        onMouseMove={menuNavigation.onMouseMove}
      >
        {items.map((item) => (
          <Box key={item.id}>
            <MenuPopoverItemRend item={item} close={onClose} />
          </Box>
        ))}
      </Stack>
    </Popover>
  );
};

export type MenuPopoverBuilderArgs = {
  ref: React.RefCallback<HTMLElement | null>;
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

export type MenuPopoverBuilderProps = SharedProps & {
  children?: (args: MenuPopoverBuilderArgs) => React.ReactNode;
};

export const MenuPopoverBuilder = ({
  children,
  items,
  ...rest
}: MenuPopoverBuilderProps) => {
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const isOpen = Boolean(anchorEl);

  const handleOpen = (): void => {
    setAnchorEl(ref);
  };

  const handleClose = (): void => {
    setAnchorEl(null);
  };

  return (
    <>
      {children?.({
        ref: setRef,
        open: handleOpen,
        isOpen,
        close: handleClose,
      })}
      <MenuPopover
        open={isOpen}
        anchorEl={anchorEl}
        onClose={handleClose}
        items={items}
        {...rest}
      />
    </>
  );
};
