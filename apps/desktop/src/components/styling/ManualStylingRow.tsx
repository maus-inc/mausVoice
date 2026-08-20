import {
  Deselect,
  Edit,
  InfoOutlined,
  MoreVert,
  PublicOutlined,
} from "@mui/icons-material";
import {
  Box,
  IconButton,
  Radio,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import { useCallback, useMemo } from "react";
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

  const ctxMenu = useContextMenu();

  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: intl.formatMessage({ defaultMessage: "Edit" }),
        onClick: handleEdit,
      },
      { kind: "divider" },
      {
        label: intl.formatMessage({ defaultMessage: "Delete" }),
        danger: true,
        onClick: () => deleteTone(id),
      },
    ],
    [handleEdit, deleteTone, id, intl],
  );

  const isGlobal = tone?.isGlobal === true;
  const isSystem = tone?.isSystem === true;
  const canEdit = !isGlobal && !isSystem;
  const hasPrompt = Boolean(tone?.promptTemplate);
  const canDeselect = activeToneCount > 1;

  const menuItems = useMemo((): MenuPopoverItem[] => {
    const items: MenuPopoverItem[] = [];
    if (canEdit) {
      items.push({
        kind: "listItem",
        title: <FormattedMessage defaultMessage="Edit" />,
        leading: <Edit fontSize="small" />,
        onClick: ({ close }) => {
          close();
          handleEdit();
        },
      });
    }
    items.push({
      kind: "listItem",
      title: <FormattedMessage defaultMessage="View full prompt" />,
      leading: <InfoOutlined fontSize="small" />,
      onClick: ({ close }) => {
        close();
        handleViewPrompt();
      },
    });
    if (canDeselect) {
      items.push({
        kind: "listItem",
        title: <FormattedMessage defaultMessage="Deselect style" />,
        leading: <Deselect fontSize="small" />,
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
              <PublicOutlined fontSize="small" />
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
            <MoreVert fontSize="small" />
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
    </Box>
  );
};
