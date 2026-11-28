import {
  CircleMinus,
  EllipsisVertical,
  Globe,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Box,
  IconButton,
  Radio,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import type { Tone } from "@maus-inc/types";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { deleteTone, openToneEditorDialog } from "../../actions/tone.actions";
import {
  deselectActiveTone,
  setSelectedToneId,
} from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
} from "../../utils/tone.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ListTile } from "../common/ListTile";
import { prepareStyleDeleteFocus } from "./style-delete-focus";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";

// Replace - and other symbols with a period. No newlines.
const formatPromptForPreview = (prompt: string) => {
  return prompt
    .split("\n")
    .join(". ")
    .replace(/[\n\r]+/g, " ")
    .replace(/[-–—]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
};

const describeTone = (tone: Tone | undefined): string =>
  tone?.description || formatPromptForPreview(tone?.promptTemplate ?? "-");

export type ManualStylingRowProps = {
  id: string;
};

type ToneRowAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
};

const useToneRowActions = ({
  intl,
  canEdit,
  canDeselect,
  onEdit,
  onViewPrompt,
  onDeselect,
  onDelete,
}: {
  intl: ReturnType<typeof useIntl>;
  canEdit: boolean;
  canDeselect: boolean;
  onEdit: () => void;
  onViewPrompt: () => void;
  onDeselect: () => void;
  onDelete: () => void;
}): ToneRowAction[] =>
  useMemo(() => {
    const actions: ToneRowAction[] = [];
    if (canEdit) {
      actions.push({
        id: "edit",
        label: intl.formatMessage({ defaultMessage: "Edit" }),
        icon: <Pencil size={16} strokeWidth={1.9} />,
        onClick: onEdit,
      });
    }
    actions.push({
      id: "view-prompt",
      label: intl.formatMessage({ defaultMessage: "View full prompt" }),
      icon: <Info size={16} strokeWidth={1.9} />,
      onClick: onViewPrompt,
    });
    if (canDeselect) {
      actions.push({
        id: "deselect",
        label: intl.formatMessage({ defaultMessage: "Deselect style" }),
        icon: <CircleMinus size={16} strokeWidth={1.9} />,
        onClick: onDeselect,
      });
    }
    if (canEdit) {
      actions.push({
        id: "delete",
        label: intl.formatMessage({ defaultMessage: "Delete" }),
        icon: <Trash2 size={16} strokeWidth={1.9} />,
        onClick: onDelete,
        danger: true,
      });
    }
    return actions;
  }, [canDeselect, canEdit, intl, onDelete, onDeselect, onEdit, onViewPrompt]);

const toContextMenuItems = (actions: ToneRowAction[]): ContextMenuItem[] =>
  actions.flatMap((action) => {
    const item: ContextMenuItem = {
      label: action.label,
      icon: action.icon,
      onClick: action.onClick,
      ...(action.danger ? { danger: true } : {}),
    };
    return action.danger
      ? [{ kind: "divider" } as ContextMenuItem, item]
      : [item];
  });

const toMenuItems = (actions: ToneRowAction[]): MenuPopoverItem[] =>
  actions.map((action) => ({
    id: action.id,
    kind: "listItem",
    title: action.label,
    leading: action.icon,
    danger: action.danger,
    onClick: ({ close }) => {
      close();
      action.onClick();
    },
  }));

const useToneRowDelete = (id: string) => {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const deletePending = useRef(false);

  const handleDeleteRequest = useCallback(() => {
    setDeleteConfirmOpen(true);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    if (!deletePending.current) setDeleteConfirmOpen(false);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deletePending.current) return;
    deletePending.current = true;
    const restoreFocus = prepareStyleDeleteFocus(id);
    setIsDeleting(true);
    try {
      await deleteTone(id);
      setDeleteConfirmOpen(false);
      restoreFocus();
    } catch {
      // deleteTone already logged and surfaced the snackbar; keep the dialog
      // open so the user can retry or cancel.
    } finally {
      deletePending.current = false;
      setIsDeleting(false);
    }
  }, [id]);

  return {
    deleteConfirmOpen,
    isDeleting,
    requestDelete: handleDeleteRequest,
    cancelDelete: handleDeleteCancel,
    confirmDelete: handleDeleteConfirm,
  };
};

const openContextMenu = (
  event: React.MouseEvent,
  ctxMenu: ReturnType<typeof useContextMenu>,
  items: ContextMenuItem[],
): void => {
  // Yield right-clicks on editable text to the provider's clipboard menu.
  if (isEditableTarget(event.target)) return;
  ctxMenu.handleContextMenu(event.nativeEvent, items);
};

const ToneDeleteDialog = ({
  isOpen,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => (
  <ConfirmDialog
    isOpen={isOpen}
    title={<FormattedMessage defaultMessage="Delete style" />}
    content={
      <FormattedMessage defaultMessage="Are you sure you want to delete this style?" />
    }
    onCancel={onCancel}
    onConfirm={onConfirm}
    confirmLabel={<FormattedMessage defaultMessage="Delete" />}
    cancelButtonProps={{ autoFocus: true }}
    confirmButtonProps={{ color: "error" }}
    busy={isDeleting}
  />
);

const ToneRowTrailing = ({
  isGlobal,
  toneName,
  intl,
  menuItems,
}: {
  isGlobal: boolean;
  toneName: string | undefined;
  intl: ReturnType<typeof useIntl>;
  menuItems: MenuPopoverItem[];
}) => {
  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <Stack
      direction="row"
      spacing={0.5}
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
      sx={{
        alignItems: "center",
      }}
    >
      {isGlobal && (
        <Tooltip
          disableInteractive
          title={
            <FormattedMessage defaultMessage="This style is managed by your organization." />
          }
        >
          <span>
            <IconButton size="small" disabled>
              <Globe size={16} strokeWidth={1.9} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <MenuPopoverBuilder items={menuItems}>
        {({ ref, open, isOpen }) => (
          <IconButton
            ref={ref}
            aria-label={intl.formatMessage(
              { defaultMessage: "More options for {title}" },
              {
                title:
                  toneName?.trim() ||
                  intl.formatMessage({ defaultMessage: "Style" }),
              },
            )}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            data-manual-style-more=""
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            size="small"
          >
            <EllipsisVertical size={16} strokeWidth={1.9} />
          </IconButton>
        )}
      </MenuPopoverBuilder>
    </Stack>
  );
};

export const ManualStylingRow = ({ id }: ManualStylingRowProps) => {
  const intl = useIntl();
  const tone = useAppStore((state) => getRec(state.toneById, id));
  const isSelected = useAppStore(
    (state) => getManuallySelectedToneId(state) === id,
  );
  const activeToneCount = useAppStore(
    (state) => getActiveManualToneIds(state).length,
  );
  const handleEdit = useCallback(() => {
    openToneEditorDialog({ mode: "edit", toneId: id });
  }, [id]);

  const handleViewPrompt = useCallback(() => {
    produceAppState((draft) => {
      draft.tones.viewingToneId = id;
      draft.tones.viewingToneOpen = true;
    });
  }, [id]);

  const handleSelect = useCallback(() => {
    setSelectedToneId(id);
  }, [id]);

  const handleDeselect = useCallback(() => {
    deselectActiveTone(id);
  }, [id]);

  const isGlobal = tone?.isGlobal === true;
  const isSystem = tone?.isSystem === true;
  const canEdit = !isGlobal && !isSystem;
  const canDeselect = activeToneCount > 1;
  const ctxMenu = useContextMenu();
  const {
    deleteConfirmOpen,
    isDeleting,
    requestDelete: handleDeleteRequest,
    cancelDelete: handleDeleteCancel,
    confirmDelete: handleDeleteConfirm,
  } = useToneRowDelete(id);

  // One descriptor list feeds both affordances, so the menu and the context
  // menu cannot drift apart on which actions a tone allows.
  const rowActions = useToneRowActions({
    intl,
    canEdit,
    canDeselect,
    onEdit: handleEdit,
    onViewPrompt: handleViewPrompt,
    onDeselect: handleDeselect,
    onDelete: handleDeleteRequest,
  });
  const contextMenuItems = useMemo(
    () => toContextMenuItems(rowActions),
    [rowActions],
  );
  const menuItems = useMemo(() => toMenuItems(rowActions), [rowActions]);

  const trailing = (
    <ToneRowTrailing
      isGlobal={isGlobal}
      toneName={tone?.name}
      intl={intl}
      menuItems={menuItems}
    />
  );

  return (
    <Box
      component="div"
      data-manual-style-row={id}
      onContextMenu={(e) => openContextMenu(e, ctxMenu, contextMenuItems)}
    >
      <ListTile
        onClick={handleSelect}
        leading={
          // Decorative selection indicator: the row button carries the
          // action and semantics, so this must not be a nested control.
          <Radio
            checked={isSelected}
            size="small"
            disableRipple
            tabIndex={-1}
            aria-hidden="true"
            sx={{ mr: 1, pointerEvents: "none" }}
          />
        }
        title={tone?.name}
        subtitle={
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {describeTone(tone)}
          </Typography>
        }
        trailing={trailing}
        sx={{ backgroundColor: "level1", mb: 1, borderRadius: 1 }}
      />
      {ctxMenu.renderMenu()}
      <ToneDeleteDialog
        isOpen={deleteConfirmOpen}
        isDeleting={isDeleting}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
};
