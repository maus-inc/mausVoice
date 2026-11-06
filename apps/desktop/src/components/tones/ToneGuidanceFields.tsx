import { TextField } from "@mui/material";
import type { Ref } from "react";
import { MAX_PREVIEW_SAMPLE_LEN } from "../../actions/tone-preview.actions";
import { FormattedMessage, useIntl } from "react-intl";
import { countLabel, MAX_EXAMPLE_LEN, MAX_OUTPUT_LEN } from "./tone-form.utils";

export const ToneOutputLengthField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) => {
  const intl = useIntl();
  return (
    <TextField
      label={<FormattedMessage defaultMessage="Output length" />}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      fullWidth
      helperText={countLabel(value, MAX_OUTPUT_LEN)}
      placeholder={intl.formatMessage({ defaultMessage: "1–3 sentences" })}
      slotProps={{ htmlInput: { maxLength: MAX_OUTPUT_LEN } }}
    />
  );
};

export const ToneExampleField = ({
  value,
  onChange,
}: Parameters<typeof ToneOutputLengthField>[0]) => {
  const intl = useIntl();
  return (
    <TextField
      label={<FormattedMessage defaultMessage="Example input and output" />}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      multiline
      rows={3}
      fullWidth
      helperText={countLabel(value, MAX_EXAMPLE_LEN)}
      placeholder={intl.formatMessage({
        defaultMessage: "Input: ... Output: ...",
      })}
      slotProps={{ htmlInput: { maxLength: MAX_EXAMPLE_LEN } }}
    />
  );
};

export const TonePreviewSampleField = ({
  value,
  onChange,
  inputRef,
}: Parameters<typeof ToneOutputLengthField>[0] & {
  inputRef?: Ref<HTMLTextAreaElement>;
}) => {
  const intl = useIntl();
  return (
    <TextField
      inputRef={inputRef}
      value={value}
      label={
        <FormattedMessage defaultMessage="Sample dictation to restyle..." />
      }
      slotProps={{ htmlInput: { maxLength: MAX_PREVIEW_SAMPLE_LEN } }}
      helperText={countLabel(value, MAX_PREVIEW_SAMPLE_LEN)}
      onChange={(event) => onChange(event.target.value)}
      multiline
      rows={3}
      fullWidth
      placeholder={intl.formatMessage({
        defaultMessage: "Sample dictation to restyle...",
      })}
    />
  );
};
