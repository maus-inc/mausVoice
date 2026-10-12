import { Stack, TextField, Typography } from "@mui/material";
import type { Ref } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ConfirmationPhrase } from "./ConfirmationPhrase";

export type ConfirmationFieldProps = {
  /** The literal the person has to reproduce, exactly. */
  phrase: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
};

/**
 * The typed confirmation both destructive dialogs end with: the instruction,
 * the literal set apart from it, and the field that has to match.
 *
 * They were two copies of the same markup, instructions and all, which is how
 * one dialog ended up with a medium field and the other with a small one for
 * the same question. The field carries no visible label because the line above
 * it already names the word to type; its accessible name is set here, so both
 * dialogs keep one.
 */
export const ConfirmationField = ({
  phrase,
  value,
  onChange,
  disabled,
  inputRef,
}: ConfirmationFieldProps) => {
  const intl = useIntl();

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2">
        <FormattedMessage
          defaultMessage="Type {phrase} to confirm."
          values={{
            phrase: <ConfirmationPhrase>{phrase}</ConfirmationPhrase>,
          }}
        />
      </Typography>
      <TextField
        inputRef={inputRef}
        fullWidth
        size="small"
        slotProps={{
          htmlInput: {
            "aria-label": intl.formatMessage({
              defaultMessage: "Confirmation phrase",
            }),
          },
        }}
        placeholder={phrase}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </Stack>
  );
};
