import { Edit, PublicOutlined } from "@mui/icons-material";
import Add from "@mui/icons-material/Add";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import { Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { useCallback, useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { openToneEditorDialog } from "../../actions/tone.actions";
import { setActiveToneIds } from "../../actions/user.actions";
import { useAppStore } from "../../store";
import {
  getActiveManualToneIds,
  getSortedToneIds,
} from "../../utils/tone.utils";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";

const StyleSelectionIcon = ({
  active,
  lastActive,
}: {
  active: boolean;
  lastActive: boolean;
}) => {
  if (lastActive) {
    return (
      <Tooltip
        disableInteractive
        title={
          <FormattedMessage defaultMessage="At least one style must be selected." />
        }
      >
        <CheckBoxIcon fontSize="small" sx={{ color: "text.disabled" }} />
      </Tooltip>
    );
  }
  if (active) return <CheckBoxIcon fontSize="small" color="primary" />;
  return <CheckBoxOutlineBlankIcon fontSize="small" />;
};

export function ManualAddStyle() {
  const toneById = useAppStore((state) => state.toneById);
  const sortedToneIds = useAppStore((state) => getSortedToneIds(state));
  const activeToneIds = useAppStore((state) => getActiveManualToneIds(state));

  const allTones = useMemo(
    () => sortedToneIds.map((id) => toneById[id]).filter(Boolean) as Tone[],
    [sortedToneIds, toneById],
  );

  const activeSet = useMemo(() => new Set(activeToneIds), [activeToneIds]);

  const handleToggle = useCallback(
    (toneId: string) => {
      const isActive = activeSet.has(toneId);
      if (isActive) {
        if (activeSet.size <= 1) return;
        const next = allTones
          .filter((t) => activeSet.has(t.id) && t.id !== toneId)
          .map((t) => t.id);
        setActiveToneIds(next);
      } else {
        const next = allTones
          .filter((t) => activeSet.has(t.id) || t.id === toneId)
          .map((t) => t.id);
        setActiveToneIds(next);
      }
    },
    [activeSet, allTones],
  );

  const menuItems = useMemo((): MenuPopoverItem[] => {
    const items: MenuPopoverItem[] = [];

    items.push({
      id: "create-style",
      kind: "listItem",
      leading: <Add fontSize="small" />,
      title: <FormattedMessage defaultMessage="New style" />,
      onClick: ({ close }) => {
        close();
        openToneEditorDialog({ mode: "create" });
      },
    });
    items.push(
      { id: "available-styles", kind: "divider" },
      ...allTones.map((tone): MenuPopoverItem => {
        const isActive = activeSet.has(tone.id);
        const isGlobal = tone.isGlobal === true;
        const isSystem = tone.isSystem === true;
        const canEdit = !isGlobal && !isSystem;
        const canDeselect = isActive && activeSet.size > 1;
        const isLastActive = isActive && !canDeselect;

        return {
          id: `style-${tone.id}`,
          kind: "listItem",
          leading: (
            <StyleSelectionIcon active={isActive} lastActive={isLastActive} />
          ),
          title: (
            <Typography variant="body2" noWrap>
              {tone.name}
            </Typography>
          ),
          trailing: (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: "center",
                mr: -1,
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
              {canEdit && (
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    openToneEditorDialog({ mode: "edit", toneId: tone.id });
                  }}
                >
                  <Edit fontSize="small" />
                </IconButton>
              )}
            </Stack>
          ),
          onClick: () => {
            if (!isActive || canDeselect) {
              handleToggle(tone.id);
            }
          },
        };
      }),
    );

    return items;
  }, [allTones, activeSet, handleToggle]);

  return (
    <MenuPopoverBuilder items={menuItems}>
      {({ ref, open }) => (
        <Button
          ref={ref}
          onClick={open}
          variant="contained"
          startIcon={<Add />}
        >
          <FormattedMessage defaultMessage="Add Style" />
        </Button>
      )}
    </MenuPopoverBuilder>
  );
}
