import { ArrowRight, Globe, Trash2 } from "lucide-react";
import { IconButton, Stack, TextField, Tooltip } from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { useDictionaryRowEditor } from "./useDictionaryRowEditor";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";

export type DictionaryRowProps = {
  id: string;
};

export const DictionaryRow = ({ id }: DictionaryRowProps) => {
  const intl = useIntl();
  const term = useAppStore((state) => getRec(state.termById, id));
  const {
    sourceValue,
    destinationValue,
    handleFieldChange,
    handleCommit,
    handleDelete,
  } = useDictionaryRowEditor(id, term);
  const isReplacement = term?.isReplacement ?? true;
  const isGlobal = term?.isGlobal ?? false;

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
          alignItems: "center",
          py: 1,
        }}
      >
        <TextField
          variant="outlined"
          size="small"
          placeholder={
            isReplacement
              ? intl.formatMessage({ defaultMessage: "Original" })
              : intl.formatMessage({ defaultMessage: "Glossary term" })
          }
          value={sourceValue}
          onChange={handleFieldChange("source")}
          onBlur={handleCommit}
          disabled={isGlobal}
          sx={{ flex: 1 }}
          error={!isGlobal && sourceValue.trim() === ""}
        />
        {isReplacement ? (
          <>
            <ArrowRight size={16} strokeWidth={1.9} aria-hidden />
            <TextField
              variant="outlined"
              size="small"
              placeholder={intl.formatMessage({
                defaultMessage: "Replacement",
              })}
              value={destinationValue}
              onChange={handleFieldChange("destination")}
              onBlur={handleCommit}
              disabled={isGlobal}
              multiline
              minRows={1}
              sx={{ flex: 1, "& textarea": { lineHeight: 1.5 } }}
              error={!isGlobal && destinationValue.trim() === ""}
            />
          </>
        ) : null}
        {isGlobal ? (
          <Tooltip
            disableInteractive
            title={
              <FormattedMessage defaultMessage="This term is managed by your organization." />
            }
          >
            <span>
              <IconButton size="small" disabled>
                <Globe size={16} strokeWidth={1.9} />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <IconButton
            aria-label={intl.formatMessage(
              { defaultMessage: "Delete dictionary item {term}" },
              { term: term.sourceValue },
            )}
            onClick={handleDelete}
            size="small"
          >
            <Trash2 size={16} strokeWidth={1.9} />
          </IconButton>
        )}
      </Stack>
    </>
  );
};
