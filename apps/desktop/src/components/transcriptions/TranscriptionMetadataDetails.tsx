import type { Transcription } from "@maus-inc/types";
import { Box, Divider, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import type { AppState } from "../../state/app.state";
import { TranscriptionTextBlock } from "./TranscriptionTextBlock";

const unknown = () => <FormattedMessage defaultMessage="Unknown" />;
const textOrUnknown = (value?: string | null): ReactNode =>
  value?.trim() || unknown();
const modelSizeLabel = (value?: string | null): ReactNode => {
  const trimmed = value?.trim();
  return trimmed
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
    : unknown();
};
const durationLabel = (ms?: number | null): string | null => {
  if (ms == null) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
};
const apiKeyLabel = (
  records: AppState["apiKeyById"],
  id?: string | null,
): string => {
  if (!id) return "None";
  const record = records[id];
  if (!record) return "Unknown";
  const suffix = record.keySuffix?.trim();
  return suffix ? `${record.name} (••••${suffix})` : record.name;
};
const transcriptionModeLabel = (
  mode: Transcription["transcriptionMode"],
): ReactNode => {
  if (mode === "api") return <FormattedMessage defaultMessage="API" />;
  if (mode === "local") return <FormattedMessage defaultMessage="Local" />;
  return unknown();
};
const postProcessModeLabel = (
  mode: Transcription["postProcessMode"],
): ReactNode => {
  if (mode === "api") return <FormattedMessage defaultMessage="API" />;
  if (mode === "fast")
    return <FormattedMessage defaultMessage="Fast (local)" />;
  return <FormattedMessage defaultMessage="Disabled" />;
};
const DetailField = ({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) => (
  <Box>
    <Typography variant="caption" sx={{ color: "text.secondary" }}>
      {label}
    </Typography>
    <Typography variant="body2" sx={{ fontWeight: 600 }}>
      {value}
    </Typography>
  </Box>
);

/**
 * Key each warning by its own text plus its occurrence, so a reordering of the
 * list cannot renumber the rows React reuses.
 */
const warningEntries = (warnings: string[]) => {
  const occurrences = new Map<string, number>();
  return warnings.map((warning) => {
    const occurrence = (occurrences.get(warning) ?? 0) + 1;
    occurrences.set(warning, occurrence);
    return { warning, key: `${warning}#${occurrence}` };
  });
};

const Warnings = ({ warnings }: { warnings: string[] }) => {
  if (!warnings.length) return null;
  return (
    <>
      <Divider />
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="Warnings" />
        </Typography>
        <Stack spacing={1} sx={{ mt: 1 }}>
          {warningEntries(warnings).map(({ warning, key }) => (
            <Box
              key={key}
              sx={(theme) => ({
                p: 1,
                borderRadius: 1,
                bgcolor:
                  theme.vars?.palette.level1 ??
                  theme.palette.background.default,
              })}
            >
              <Typography
                variant="body2"
                sx={(theme) => ({
                  color:
                    theme.vars?.palette.warning?.main ??
                    theme.palette.warning.main,
                })}
              >
                {warning}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Box>
    </>
  );
};
const Performance = ({
  transcription,
  postprocess,
}: {
  transcription: string | null;
  postprocess: string | null;
}) => {
  if (!transcription && !postprocess) return null;
  return (
    <>
      <Divider />
      <Box>
        <Typography variant="overline" sx={{ color: "text.secondary" }}>
          <FormattedMessage defaultMessage="Performance" />
        </Typography>
        <Stack spacing={1.25} sx={{ mt: 1 }}>
          {transcription && (
            <DetailField
              label={
                <FormattedMessage defaultMessage="Transcription Duration" />
              }
              value={transcription}
            />
          )}
          {postprocess && (
            <DetailField
              label={
                <FormattedMessage defaultMessage="Post-processing Duration" />
              }
              value={postprocess}
            />
          )}
        </Stack>
      </Box>
    </>
  );
};
const Step = ({
  title,
  fields,
  prompt,
  placeholder,
}: {
  title: ReactNode;
  fields: { key: string; label: ReactNode; value: ReactNode }[];
  prompt: string | null;
  placeholder: ReactNode;
}) => (
  <>
    <Divider />
    <Box>
      <Typography variant="overline" sx={{ color: "text.secondary" }}>
        {title}
      </Typography>
      <Stack spacing={1.25} sx={{ mt: 1 }}>
        {fields.map(({ key, label, value }) => (
          <DetailField key={key} label={label} value={value} />
        ))}
        <TranscriptionTextBlock
          label={<FormattedMessage defaultMessage="Prompt" />}
          value={prompt}
          placeholder={placeholder}
          monospace
        />
      </Stack>
    </Box>
  </>
);

export const TranscriptionMetadataDetails = ({
  transcription,
  apiKeysById,
  rawTranscriptText,
}: {
  transcription: Transcription;
  apiKeysById: AppState["apiKeyById"];
  rawTranscriptText: string;
}) => {
  const warnings = (transcription.warnings ?? [])
    .map((warning) => warning.trim())
    .filter(Boolean);
  const transcriptionPrompt = transcription.transcriptionPrompt?.trim() || null;
  let postProcessPrompt = transcription.postProcessPrompt?.trim() ?? "";
  if (rawTranscriptText)
    postProcessPrompt = postProcessPrompt.replace(
      rawTranscriptText.trim(),
      "<transcript>",
    );
  return (
    <>
      <Warnings warnings={warnings} />
      <Performance
        transcription={durationLabel(transcription.transcriptionDurationMs)}
        postprocess={durationLabel(transcription.postprocessDurationMs)}
      />
      <Step
        title={<FormattedMessage defaultMessage="Transcription Step" />}
        fields={[
          {
            key: "mode",
            label: <FormattedMessage defaultMessage="Mode" />,
            value: transcriptionModeLabel(transcription.transcriptionMode),
          },
          {
            key: "device",
            label: <FormattedMessage defaultMessage="Device" />,
            value: textOrUnknown(transcription.inferenceDevice),
          },
          {
            key: "model",
            label: <FormattedMessage defaultMessage="Model Size" />,
            value: modelSizeLabel(transcription.modelSize),
          },
          {
            key: "key",
            label: <FormattedMessage defaultMessage="API key" />,
            value: apiKeyLabel(
              apiKeysById,
              transcription.transcriptionApiKeyId,
            ),
          },
        ]}
        prompt={transcriptionPrompt}
        placeholder={
          <FormattedMessage defaultMessage="No custom prompt applied." />
        }
      />
      <Step
        title={<FormattedMessage defaultMessage="Post-processing Step" />}
        fields={[
          {
            key: "mode",
            label: <FormattedMessage defaultMessage="Mode" />,
            value: postProcessModeLabel(transcription.postProcessMode),
          },
          {
            key: "device",
            label: <FormattedMessage defaultMessage="Processor" />,
            value: textOrUnknown(transcription.postProcessDevice),
          },
          {
            key: "model",
            label: <FormattedMessage defaultMessage="Model" />,
            value: textOrUnknown(transcription.postProcessModel),
          },
          {
            key: "key",
            label: <FormattedMessage defaultMessage="API key" />,
            value: apiKeyLabel(apiKeysById, transcription.postProcessApiKeyId),
          },
        ]}
        prompt={postProcessPrompt || null}
        placeholder={
          <FormattedMessage defaultMessage="No LLM post-processing was applied." />
        }
      />
    </>
  );
};
