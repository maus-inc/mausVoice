import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { PublicOutlined } from "@mui/icons-material";
import { IconButton, Stack, TextField, Tooltip } from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTermRepo } from "../../repos";
import { getAppState, produceAppState, useAppStore } from "../../store";
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
  const [sourceValue, setSourceValue] = useState(term?.sourceValue ?? "");
  const [destinationValue, setDestinationValue] = useState(
    term?.destinationValue ?? "",
  );
  const isReplacement = term?.isReplacement ?? true;
  const isGlobal = term?.isGlobal ?? false;

  useEffect(() => {
    setSourceValue(term?.sourceValue ?? "");
    setDestinationValue(term?.destinationValue ?? "");
  }, [term?.sourceValue, term?.destinationValue]);

  const handleFieldChange =
    (field: "source" | "destination") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      if (field === "source") {
        setSourceValue(event.target.value);
      } else {
        setDestinationValue(event.target.value);
      }
    };

  const handleCommit = useCallback(async () => {
    if (!term) {
      return;
    }

    if (
      term.sourceValue === sourceValue &&
      term.destinationValue === destinationValue
    ) {
      return;
    }

    const previousTerm = term;
    const updatedTerm = {
      ...term,
      sourceValue,
      destinationValue,
    };

    produceAppState((draft) => {
      draft.termById[id] = updatedTerm;
    });

    try {
      await getTermRepo().updateTerm(updatedTerm);
    } catch (error) {
      produceAppState((draft) => {
        draft.termById[id] = previousTerm;
      });
      setSourceValue(previousTerm.sourceValue);
      setDestinationValue(previousTerm.destinationValue);
      showErrorSnackbar(error);
    }
  }, [destinationValue, id, sourceValue, term]);

  const handleDelete = useCallback(async () => {
    if (!term) {
      return;
    }

    const previousTerm = term;
    const previousIds = [...getAppState().dictionary.termIds];

    produceAppState((draft) => {
      delete draft.termById[id];
      draft.dictionary.termIds = draft.dictionary.termIds.filter(
        (termId) => termId !== id,
      );
    });

    try {
      await getTermRepo().deleteTerm(id);
    } catch (error) {
      produceAppState((draft) => {
        draft.termById[id] = previousTerm;
        draft.dictionary.termIds = previousIds;
      });
      setSourceValue(previousTerm.sourceValue);
      setDestinationValue(previousTerm.destinationValue);
      showErrorSnackbar(error);
    }
  }, [id, term]);

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
            <ArrowForwardRoundedIcon color="action" fontSize="small" />
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
                <PublicOutlined fontSize="small" />
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
            <DeleteOutlineRoundedIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
    </>
  );
};
