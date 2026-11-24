import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { RefObject } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  countLabel,
  MAX_EXAMPLE_LEN,
  MAX_OUTPUT_LEN,
  MAX_PROMPT_LEN,
} from "./tone-form.utils";

type ToneTuneFieldsProps = {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  promptTemplate: string;
  trimmedPrompt: string;
  outputLength: string;
  exampleInputOutput: string;
  onPromptChange: (value: string) => void;
  onOutputLengthChange: (value: string) => void;
  onExampleChange: (value: string) => void;
};

export const ToneTuneFields = ({
  promptRef,
  promptTemplate,
  trimmedPrompt,
  outputLength,
  exampleInputOutput,
  onPromptChange,
  onOutputLengthChange,
  onExampleChange,
}: ToneTuneFieldsProps) => {
  const intl = useIntl();
  const promptMissing = promptTemplate.length > 0 && !trimmedPrompt;

  return (
    <Stack spacing={3} sx={{ pt: 1 }}>
      <TextField
        inputRef={promptRef}
        label={<FormattedMessage defaultMessage="Prompt" />}
        value={promptTemplate}
        onChange={(event) => onPromptChange(event.target.value)}
        multiline
        rows={5}
        fullWidth
        required
        error={promptMissing}
        helperText={
          promptMissing ? (
            <FormattedMessage defaultMessage="Describe how the style should sound." />
          ) : (
            countLabel(promptTemplate, MAX_PROMPT_LEN)
          )
        }
        placeholder={intl.formatMessage({
          defaultMessage:
            "Make it sound like a professional but friendly email. Use jargon and fun words.",
        })}
        slotProps={{ htmlInput: { maxLength: MAX_PROMPT_LEN } }}
      />
      <TextField
        label={<FormattedMessage defaultMessage="Output length" />}
        value={outputLength}
        onChange={(event) => onOutputLengthChange(event.target.value)}
        fullWidth
        helperText={countLabel(outputLength, MAX_OUTPUT_LEN)}
        placeholder={intl.formatMessage({ defaultMessage: "1–3 sentences" })}
        slotProps={{ htmlInput: { maxLength: MAX_OUTPUT_LEN } }}
      />
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
      <Accordion disableGutters>
        <AccordionSummary>
          <Typography variant="subtitle2">
            <FormattedMessage defaultMessage="Writing tips" />
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Name the voice first, then the rules. One sentence of example output beats a paragraph of adjectives. Mention what to avoid only when the model keeps doing it." />
          </Typography>
        </AccordionDetails>
      </Accordion>
      <Accordion disableGutters>
        <AccordionSummary>
          <Typography variant="subtitle2">
            <FormattedMessage defaultMessage="Advanced" />
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="The prompt runs as the style instruction on every post-processing pass, with your category, length, and example appended as guidance. Keep it under a paragraph so it stays cheap and predictable." />
          </Typography>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
};
