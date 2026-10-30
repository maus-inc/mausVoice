import { ArrowRight, Globe, Trash2 } from "lucide-react";
import { IconButton, Stack, TextField, Tooltip } from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { focusAfterDictionaryDelete } from "./dictionary-delete-focus";
import {
  deleteDictionaryTerm,
  updateDictionaryTerm,
} from "../../utils/term-mutation-queue";
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

  const lastSource = useRef(term?.sourceValue ?? "");
  const lastDestination = useRef(term?.destinationValue ?? "");
  useEffect(() => {
    const nextSource = term?.sourceValue ?? "";
    const nextDestination = term?.destinationValue ?? "";
    // Do not overwrite a newer, still-uncommitted draft when a previous
    // request succeeds or rolls back.
    const previousSource = lastSource.current;
    const previousDestination = lastDestination.current;
    setSourceValue((value) => (value === previousSource ? nextSource : value));
    setDestinationValue((value) =>
      value === previousDestination ? nextDestination : value,
    );
    lastSource.current = nextSource;
    lastDestination.current = nextDestination;
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
    if (
      !term ||
      !sourceValue.trim() ||
      (isReplacement && !destinationValue.trim())
    ) {
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

    await updateDictionaryTerm(previousTerm, updatedTerm, (saved, error) => {
      if (getAppState().termById[id] === updatedTerm) {
        produceAppState((draft) => {
          draft.termById[id] = saved;
        });
      }
      showErrorSnackbar(error);
    });
  }, [destinationValue, id, isReplacement, sourceValue, term]);

  const handleDelete = useCallback(async () => {
    if (!term) {
      return;
    }

    const previousTerm = term;
    const previousIds = [...getAppState().dictionary.termIds];
    focusAfterDictionaryDelete(id);

    produceAppState((draft) => {
      delete draft.termById[id];
      draft.dictionary.termIds = draft.dictionary.termIds.filter(
        (termId) => termId !== id,
      );
    });

    await deleteDictionaryTerm(previousTerm, (saved, error) => {
      produceAppState((draft) => {
        // Restore only this deletion, without reverting other edits or removals
        // that completed while the request was pending.
        draft.termById[id] ??= saved;
        const ids = draft.dictionary.termIds;
        if (!ids.includes(id)) {
          const oldIndex = previousIds.indexOf(id);
          const next = previousIds
            .slice(oldIndex + 1)
            .find((candidate) => ids.includes(candidate));
          const before = previousIds
            .slice(0, oldIndex)
            .reverse()
            .find((candidate) => ids.includes(candidate));
          const index = next
            ? ids.indexOf(next)
            : before
              ? ids.indexOf(before) + 1
              : Math.min(Math.max(oldIndex, 0), ids.length);
          ids.splice(index, 0, id);
        }
      });
      showErrorSnackbar(error);
    });
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
          // Keep both fields aligned when one displays a validation message.
          "& > svg": { mt: "12px" },
          "& > .MuiIconButton-root, & > span": { mt: "4px" },
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
          helperText={
            !isGlobal && !sourceValue.trim() ? (
              <FormattedMessage defaultMessage="Required. Changes not saved." />
            ) : undefined
          }
          slotProps={{
            htmlInput: {
              "aria-label": isReplacement
                ? intl.formatMessage({ defaultMessage: "Original" })
                : intl.formatMessage({ defaultMessage: "Glossary term" }),
            },
          }}
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
              helperText={
                !isGlobal && !destinationValue.trim() ? (
                  <FormattedMessage defaultMessage="Required. Changes not saved." />
                ) : undefined
              }
              slotProps={{
                htmlInput: {
                  "aria-label": intl.formatMessage({
                    defaultMessage: "Replacement",
                  }),
                },
              }}
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
            data-dictionary-delete
            aria-label={intl.formatMessage(
              { defaultMessage: "Delete dictionary item {term}" },
              { term: term.sourceValue },
            )}
            onClick={(event) => {
              // A second click at the same location may now hit the next row.
              if (event.detail <= 1) void handleDelete();
            }}
            size="small"
          >
            <Trash2 size={16} strokeWidth={1.9} />
          </IconButton>
        )}
      </Stack>
    </>
  );
};
