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
import { useCallback, useMemo, useState } from "react";
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

export type ManualStylingRowProps = {
  id: string;
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
  const hasPrompt = Boolean(tone?.promptTemplate);
  const canDeselect = activeToneCount > 1;
  const ctxMenu = useContextMenu();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteRequest = useCallback(() => {
    setDeleteConfirmOpen(true);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmOpen(false);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteTone(id);
      setDeleteConfirmOpen(false);
    } catch {
      // deleteTone already logged and surfaced the snackbar; keep the dialog
      // open so the user can retry or cancel.
    } finally {
      setIsDeleting(false);
    }
  }, [id, isDeleting]);

  // Context actions must honor the same managed/system-tone restrictions as
  // the overflow menu. The repository deletion command is not a permission
  // boundary, so exposing Delete here would otherwise bypass the UI policy.
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (canEdit) {
      items.push({
        label: intl.formatMessage({ defaultMessage: "Edit" }),
        icon: <Pencil size={16} strokeWidth={1.9} />,
        onClick: handleEdit,
      });
    }
    items.push({
      label: intl.formatMessage({ defaultMessage: "View full prompt" }),
      icon: <Info size={16} strokeWidth={1.9} />,
      onClick: handleViewPrompt,
    });
    if (canDeselect) {
      items.push({
        label: intl.formatMessage({ defaultMessage: "Deselect style" }),
        icon: <CircleMinus size={16} strokeWidth={1.9} />,
        onClick: handleDeselect,
      });
    }
    if (canEdit) {
      items.push(
        { kind: "divider" },
        {
          label: intl.formatMessage({ defaultMessage: "Delete" }),
          icon: <Trash2 size={16} strokeWidth={1.9} />,
          danger: true,
          onClick: handleDeleteRequest,
        },
      );
    }
    return items;
  }, [
    canEdit,
    canDeselect,
    handleDeleteRequest,
    handleDeselect,
    handleEdit,
    handleViewPrompt,
    intl,
  ]);

  const menuItems = useMemo((): MenuPopoverItem[] => {
    const items: MenuPopoverItem[] = [];
    if (canEdit) {
      items.push({
        kind: "listItem",
        title: <FormattedMessage defaultMessage="Edit" />,
        leading: <Pencil size={16} strokeWidth={1.9} />,
        onClick: ({ close }) => {
          close();
          handleEdit();
        },
      });
    }
    items.push({
      kind: "listItem",
      title: <FormattedMessage defaultMessage="View full prompt" />,
      leading: <Info size={16} strokeWidth={1.9} />,
      onClick: ({ close }) => {
        close();
        handleViewPrompt();
      },
    });
    if (canDeselect) {
      items.push({
        kind: "listItem",
        title: <FormattedMessage defaultMessage="Deselect style" />,
        leading: <CircleMinus size={16} strokeWidth={1.9} />,
        onClick: ({ close }) => {
          close();
          handleDeselect();
        },
      });
    }
    return items;
  }, [
    canEdit,
    canDeselect,
    hasPrompt,
    handleEdit,
    handleViewPrompt,
    handleDeselect,
  ]);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  const trailing = (
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
        {({ ref, open }) => (
          <IconButton
            ref={ref}
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

  return (
    <Box
      component="div"
      onContextMenu={(e) => {
        // Yield right-clicks on editable text to the provider's clipboard menu.
        if (isEditableTarget(e.target)) return;
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
      }}
    >
      <ListTile
        onClick={handleSelect}
        leading={
          <Radio
            checked={isSelected}
            size="small"
            disableRipple
            sx={{ mr: 1 }}
            onClick={(e) => {
              stopPropagation(e);
              handleSelect();
            }}
            onMouseDown={stopPropagation}
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
            {tone?.description ||
              formatPromptForPreview(tone?.promptTemplate ?? "-")}
          </Typography>
        }
        trailing={trailing}
        sx={{ backgroundColor: "level1", mb: 1, borderRadius: 1 }}
      />
      {ctxMenu.renderMenu()}
      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title={<FormattedMessage defaultMessage="Delete style" />}
        content={
          <FormattedMessage defaultMessage="Are you sure you want to delete this style?" />
        }
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        confirmLabel={<FormattedMessage defaultMessage="Delete" />}
        confirmButtonProps={{ color: "error", disabled: isDeleting }}
      />
    </Box>
  );
};
