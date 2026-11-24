import { Box, Stack, TextField, Typography } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";

import { ToneBasicsFields } from "./ToneBasicsFields";
import {
  countLabel,
  MAX_EXAMPLE_LEN,
  MAX_OUTPUT_LEN,
  MAX_PROMPT_LEN,
} from "./tone-form.utils";

type ToneEditFieldsProps = {
  name: string;
  category: string;
  promptTemplate: string;
  outputLength: string;
  exampleInputOutput: string;
  trimmedPrompt: string;
  onNameChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onOutputLengthChange: (value: string) => void;
  onExampleChange: (value: string) => void;
};

export const ToneEditFields = ({
  name,
  category,
  promptTemplate,
  outputLength,
  exampleInputOutput,
  trimmedPrompt,
  onNameChange,
  onCategoryChange,
  onPromptChange,
  onOutputLengthChange,
  onExampleChange,
}: ToneEditFieldsProps) => {
  const intl = useIntl();

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          <FormattedMessage defaultMessage="Basics" />
        </Typography>
        <Stack spacing={2}>
          <ToneBasicsFields
            name={name}
            category={category}
            onNameChange={onNameChange}
            onCategoryChange={onCategoryChange}
          />
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          <FormattedMessage defaultMessage="Behavior" />
        </Typography>
        <Stack spacing={2}>
          <TextField
            label={<FormattedMessage defaultMessage="Prompt" />}
            value={promptTemplate}
            onChange={(event) => onPromptChange(event.target.value)}
            multiline
            rows={6}
            fullWidth
            required
            error={promptTemplate.length > 0 && !trimmedPrompt}
            helperText={
              promptTemplate.length > 0 && !trimmedPrompt ? (
                <FormattedMessage defaultMessage="Describe how the style should sound." />
              ) : (
                countLabel(promptTemplate, MAX_PROMPT_LEN)
              )
            }
            slotProps={{ htmlInput: { maxLength: MAX_PROMPT_LEN } }}
          />
          <TextField
            label={<FormattedMessage defaultMessage="Output length" />}
            value={outputLength}
            onChange={(event) => onOutputLengthChange(event.target.value)}
            fullWidth
            helperText={countLabel(outputLength, MAX_OUTPUT_LEN)}
            placeholder={intl.formatMessage({
              defaultMessage: "1–3 sentences",
            })}
            slotProps={{ htmlInput: { maxLength: MAX_OUTPUT_LEN } }}
          />
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          <FormattedMessage defaultMessage="Examples" />
        </Typography>
        <TextField
          label={<FormattedMessage defaultMessage="Example input and output" />}
          value={exampleInputOutput}
          onChange={(event) => onExampleChange(event.target.value)}
          multiline
          rows={3}
          fullWidth
          helperText={countLabel(exampleInputOutput, MAX_EXAMPLE_LEN)}
          placeholder={intl.formatMessage({
            defaultMessage: "Input: ... Output: ...",
          })}
          slotProps={{ htmlInput: { maxLength: MAX_EXAMPLE_LEN } }}
        />
      </Box>
    </Stack>
  );
};
