import { ArrowRight } from "lucide-react";
import { Box, TextField } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import type { DictionaryDraft } from "./use-dictionary-draft";

/**
 * The replacement field's control box: its `1.5` line box (22.5px at the body
 * text size) inside the outlined input's 8.5px padding, 39.5px, rounded to the
 * 4px rhythm. It also brackets the original field's shorter 1.4375em box
 * (38.56px), so a glyph centred in it sits on both first lines, and a helper
 * text or a wrapped replacement cannot move it off them.
 */
export const FIELD_CONTROL_HEIGHT = 40;

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
          {/* A margin cannot hold this line: Stack resets the margin of every
              direct child, and the field it belongs to grows downward. */}
          <Box
            data-dictionary-arrow=""
            sx={{
              alignSelf: "flex-start",
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              height: FIELD_CONTROL_HEIGHT,
            }}
          >
            <ArrowRight size={16} strokeWidth={1.9} aria-hidden />
          </Box>
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
