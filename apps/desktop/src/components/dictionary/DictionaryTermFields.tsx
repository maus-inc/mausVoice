import { ArrowRight } from "lucide-react";
import { TextField } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import type { DictionaryDraft } from "./use-dictionary-draft";

export const DictionaryTermFields = ({
  draft,
  isReplacement,
  isGlobal,
  onCommit,
}: {
  draft: DictionaryDraft;
  isReplacement: boolean;
  isGlobal: boolean;
  onCommit: () => void;
}) => {
  const intl = useIntl();
  const sourceLabel = isReplacement
    ? intl.formatMessage({ defaultMessage: "Original" })
    : intl.formatMessage({ defaultMessage: "Glossary term" });
  const replacementLabel = intl.formatMessage({
    defaultMessage: "Replacement",
  });

  return (
    <>
      <TextField
        variant="outlined"
        size="small"
        placeholder={sourceLabel}
        value={draft.sourceValue}
        onChange={draft.handleFieldChange("source")}
        onBlur={onCommit}
        disabled={isGlobal}
        sx={{ flex: 1 }}
        error={!isGlobal && draft.sourceValue.trim() === ""}
        helperText={
          !isGlobal && !draft.sourceValue.trim() ? (
            <FormattedMessage defaultMessage="Required. Changes not saved." />
          ) : undefined
        }
        slotProps={{
          htmlInput: { "aria-label": sourceLabel },
        }}
      />
      {isReplacement ? (
        <>
          <ArrowRight size={16} strokeWidth={1.9} aria-hidden />
          <TextField
            variant="outlined"
            size="small"
            placeholder={replacementLabel}
            value={draft.destinationValue}
            onChange={draft.handleFieldChange("destination")}
            onBlur={onCommit}
            disabled={isGlobal}
            multiline
            minRows={1}
            sx={{ flex: 1, "& textarea": { lineHeight: 1.5 } }}
            error={!isGlobal && draft.destinationValue.trim() === ""}
            helperText={
              !isGlobal && !draft.destinationValue.trim() ? (
                <FormattedMessage defaultMessage="Required. Changes not saved." />
              ) : undefined
            }
            slotProps={{
              htmlInput: { "aria-label": replacementLabel },
            }}
          />
        </>
      ) : null}
    </>
  );
};
