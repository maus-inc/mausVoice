import { Trash2 } from "lucide-react";
import { Stack } from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import { DictionaryRowActions } from "./DictionaryRowActions";
import { DictionaryTermFields } from "./DictionaryTermFields";
import { useDictionaryDraft } from "./use-dictionary-draft";
import { useDictionaryTermWrites } from "./use-dictionary-term-writes";

export type DictionaryRowProps = {
  id: string;
};

export const DictionaryRow = ({ id }: DictionaryRowProps) => {
  const intl = useIntl();
  const term = useAppStore((state) => getRec(state.termById, id));
  const draft = useDictionaryDraft(term);
  const isReplacement = term?.isReplacement ?? true;
  const isGlobal = term?.isGlobal ?? false;
  const { handleCommit, handleDelete } = useDictionaryTermWrites({
    id,
    term,
    sourceValue: draft.sourceValue,
    destinationValue: draft.destinationValue,
    isReplacement,
  });
  const ctxMenu = useContextMenu();

  // Global terms are organization-managed. Keep the right-click surface in
  // lockstep with the disabled inline controls: never offer a delete path the
  // normal UI intentionally withholds.
  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () =>
      isGlobal
        ? []
        : [
            {
              label: intl.formatMessage({ defaultMessage: "Delete" }),
              icon: <Trash2 size={16} strokeWidth={1.9} />,
              danger: true,
              onClick: handleDelete,
            },
          ],
    [handleDelete, intl, isGlobal],
  );

  if (!term) {
    return null;
  }

  return (
    <>
      {ctxMenu.renderMenu()}
      <Stack
        data-dictionary-row={id}
        direction="row"
        spacing={2}
        onContextMenu={(e) => {
          // Let the provider's document listener handle inputs/textareas and
          // contenteditables so their Cut/Copy/Paste menu is not replaced by
          // this row-level Delete action.
          if (isEditableTarget(e.target) || contextMenuItems.length === 0) {
            return;
          }
          ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
        }}
        sx={{
          alignItems: "flex-start",
          py: 1,
          // Hold the row actions near the top: a validation message or a
          // wrapped replacement grows the fields downward, not the actions.
          "& > .MuiIconButton-root, & > span": { mt: "4px" },
        }}
      >
        <DictionaryTermFields
          draft={draft}
          isReplacement={isReplacement}
          isGlobal={isGlobal}
          onCommit={handleCommit}
        />
        <DictionaryRowActions
          isGlobal={isGlobal}
          termSourceValue={term.sourceValue}
          onDelete={handleDelete}
        />
      </Stack>
    </>
  );
};
