import {
  Box,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  type SxProps,
} from "@mui/material";
import { forwardRef, useState } from "react";
import type { ReactNode } from "react";
import { OverflowTypography } from "./OverflowTypography";

const normalizeSx = (sx?: SxProps | SxProps[]): SxProps[] => {
  if (Array.isArray(sx)) return sx as unknown as SxProps[];
  return sx != null ? [sx] : [];
};

// Pass role only when the caller names one: an explicit undefined role
// overrides ButtonBase's implicit "button" role on non-native buttons and
// silently strips the row's actionability semantics. Menu-item rows leave
// roving tabindex management to the menu.
const buildRoleProps = (
  itemRole?: React.AriaRole,
): { role?: React.AriaRole; tabIndex?: number } => {
  if (!itemRole) return {};
  return itemRole.startsWith("menuitem")
    ? { role: itemRole, tabIndex: -1 }
    : { role: itemRole };
};

type HoverButtonProps = {
  idle: ReactNode;
  hover?: ReactNode;
  hovered: boolean;
  // Set when the hover control sits inside a clickable row: a focusable
  // control nested in the row button is a nested-interactive violation, so
  // the hover swap becomes a pointer-only affordance (aria-hidden, skipped
  // by keyboard) and the row button carries the keyboard action.
  nestedControl?: boolean;
};

const HoverButton = ({
  idle,
  hover,
  hovered,
  nestedControl,
}: HoverButtonProps) => {
  const hoverState = hovered && hover;

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <Box sx={{ flexShrink: 0, display: "inline-flex", ml: 1 }}>
      <Typography
        variant="body2"
        component="span"
        sx={{ fontWeight: "bold", display: "flex", alignItems: "center" }}
      >
        <Box sx={{ display: hoverState ? "none" : "inline-flex" }}>{idle}</Box>
        {hover ? (
          <IconButton
            onClick={handleClick}
            onMouseDown={handleClick}
            component="div"
            tabIndex={nestedControl ? -1 : undefined}
            aria-hidden={nestedControl ? true : undefined}
            size="small"
            sx={{
              my: -1,
              mr: -1.5,
              display: hoverState ? "inline-flex" : "none",
            }}
          >
            {hover}
          </IconButton>
        ) : null}
      </Typography>
    </Box>
  );
};

/** The leading slot keeps the row's bold body copy and its inline alignment. */
const ListTileLeading = ({ children }: { children: ReactNode }) => (
  <Box sx={{ flexShrink: 0, display: "inline-flex", mr: 1 }}>
    <Typography
      variant="body2"
      component="span"
      sx={{ fontWeight: "bold", display: "flex", alignItems: "center" }}
    >
      {children}
    </Typography>
  </Box>
);

const ListTileTrailing = ({
  idle,
  hover,
  hovered,
}: {
  idle: ReactNode;
  hover?: ReactNode;
  hovered: boolean;
}) =>
  idle ? <HoverButton idle={idle} hover={hover} hovered={hovered} /> : null;

const ListTileContent = ({
  leading,
  title,
  subtitle,
  trailing,
  inFlow,
}: {
  leading: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  trailing: ReactNode;
  inFlow: boolean;
}) => (
  <Stack direction="row" sx={{ alignItems: "center", width: "100%" }}>
    {leading ? <ListTileLeading>{leading}</ListTileLeading> : null}
    <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
      <ListItemText
        primary={<OverflowTypography>{title}</OverflowTypography>}
        secondary={subtitle}
      />
    </Box>
    {inFlow ? trailing : null}
  </Stack>
);

const ROW_TRANSITION = (theme: import("@mui/material/styles").Theme) =>
  [
    theme.transitions.create("background-color", {
      duration: theme.transitions.duration.shortest,
    }),
    "transform 90ms var(--ease-out-cubic)",
  ].join(", ");

const PRESS_STYLES = {
  "&:active:not(:disabled), &:focus-visible:active:not(:disabled), &.Mui-focusVisible:active:not(:disabled)":
    {
      transform: "scale(0.96)",
    },
  "@media (prefers-reduced-motion: reduce)": {
    transition: "none",
    "&:active:not(:disabled), &:focus-visible:active:not(:disabled), &.Mui-focusVisible:active:not(:disabled)":
      {
        transform: "none",
      },
  },
};

type ListTileBodyProps = {
  isClickable: boolean;
  selected: boolean;
  disabled: boolean | undefined;
  roleProps: ReturnType<typeof buildRoleProps>;
  ariaChecked: React.AriaAttributes["aria-checked"];
  ariaCurrent: React.AriaAttributes["aria-current"];
  disableRipple: boolean;
  onClick: ListTileProps["onClick"];
  content: ReactNode;
  indicator: ReactNode;
  trailing: ReactNode;
};

/**
 * A clickable row's trailing controls render outside its button (never nested
 * inside it); plain clicks in the slot still forward to the row action.
 */
const ListTileBody = ({
  isClickable,
  selected,
  disabled,
  roleProps,
  ariaChecked,
  ariaCurrent,
  disableRipple,
  onClick,
  content,
  indicator,
  trailing,
}: ListTileBodyProps) => {
  if (!isClickable) {
    return (
      <>
        {indicator}
        <Box
          inert={disabled}
          sx={{
            width: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            px: 2,
            py: 1.25,
            mb: 0.5,
            opacity: disabled
              ? (theme) => theme.palette.action.disabledOpacity
              : undefined,
          }}
        >
          {content}
        </Box>
      </>
    );
  }

  return (
    <>
      {indicator}
      <ListItemButton
        selected={selected}
        {...roleProps}
        aria-checked={ariaChecked}
        aria-current={ariaCurrent}
        onClick={onClick}
        disabled={disabled}
        disableRipple={disableRipple}
        sx={(theme) => ({
          position: "relative",
          zIndex: 1,
          transformOrigin: "center",
          // No will-change: transform is already compositor-friendly and
          // adding a layer for every row would cost GPU memory on long lists.
          // Tested on macOS Apple Silicon, macOS Intel, Windows 11, and
          // Linux with integrated GPU. Press stays smooth without the hint.
          // Re-add willChange only if jank appears on low-end devices.
          transition: ROW_TRANSITION(theme),
          ...PRESS_STYLES,
        })}
      >
        {content}
      </ListItemButton>
      {trailing ? (
        <Box onClick={disabled ? undefined : onClick} sx={{ flexShrink: 0 }}>
          {trailing}
        </Box>
      ) : null}
    </>
  );
};

const useListTileHover = () => {
  const [hovered, setHovered] = useState(false);

  return {
    hovered,
    shellHandlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocusCapture: () => setHovered(true),
      onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setHovered(false);
        }
      },
    },
  };
};

export type ListTileComponent = "div" | "li";

export type ListTileProps<C extends ListTileComponent = "div"> = {
  title?: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  trailingHover?: ReactNode;
  leading?: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  selected?: boolean;
  /** Optional role for the interactive tile, such as an action menu item. */
  itemRole?: React.AriaRole;
  ariaChecked?: React.AriaAttributes["aria-checked"];
  ariaCurrent?: React.AriaAttributes["aria-current"];
  /**
   * Render as a list item when this tile is a child of a List. The generic
   * parameter is what makes the forwarded ref honest: a `li` tile hands back an
   * `HTMLLIElement`, and advertising `HTMLDivElement` let a consumer reach for
   * `div`-only members on an element that has none.
   */
  component?: C;
  sx?: SxProps;
  disabled?: boolean;
  disableRipple?: boolean;
  /** Optional indicator slot (e.g. motion layoutId pill) rendered behind content */
  indicator?: ReactNode;
};

/** The element a `ListTile` renders, which its ref must therefore point at. */
export type ListTileElement<C extends ListTileComponent> = C extends "li"
  ? HTMLLIElement
  : HTMLDivElement;

export const ListTile = forwardRef(function ListTile<
  C extends ListTileComponent = "div",
>(
  {
    title,
    subtitle,
    trailing,
    trailingHover,
    leading,
    onClick,
    selected = false,
    itemRole,
    ariaChecked,
    ariaCurrent,
    component = "div" as C,
    sx,
    disabled,
    disableRipple = true,
    indicator,
  }: ListTileProps<C>,
  ref: React.Ref<ListTileElement<C>>,
) {
  const { hovered, shellHandlers } = useListTileHover();
  const isClickable = Boolean(onClick);

  const content = (
    <ListTileContent
      leading={leading}
      title={title}
      subtitle={subtitle}
      trailing={
        <ListTileTrailing
          idle={trailing}
          hover={trailingHover}
          hovered={hovered}
        />
      }
      inFlow={!isClickable}
    />
  );

  const body = (
    <ListTileBody
      isClickable={isClickable}
      selected={selected}
      disabled={disabled}
      roleProps={buildRoleProps(itemRole)}
      ariaChecked={ariaChecked}
      ariaCurrent={ariaCurrent}
      disableRipple={disableRipple}
      onClick={onClick}
      content={content}
      indicator={indicator}
      trailing={
        <ListTileTrailing
          idle={trailing}
          hover={trailingHover}
          hovered={hovered}
        />
      }
    />
  );

  const shellProps = {
    ...shellHandlers,
    disablePadding: true,
    sx: [{ position: "relative" }, ...normalizeSx(sx)] as SxProps,
  };

  // `ListItem` declares `component` through a generic overload that cannot
  // accept a ref for an unresolved `C`, so each element is named literally
  // here. That is what lets the forwarded ref carry the real element type
  // instead of being widened away to `HTMLDivElement` for both.
  return component === "li" ? (
    <ListItem
      component="li"
      ref={ref as React.Ref<HTMLLIElement>}
      {...shellProps}
    >
      {body}
    </ListItem>
  ) : (
    <ListItem
      component="div"
      ref={ref as React.Ref<HTMLDivElement>}
      {...shellProps}
    >
      {body}
    </ListItem>
  );
}) as <C extends ListTileComponent = "div">(
  props: ListTileProps<C> & { ref?: React.Ref<ListTileElement<C>> },
) => React.ReactElement;
