import { useMemo } from "react";
import type { ReactNode } from "react";
import { FormattedMessage, type IntlShape } from "react-intl";
import { getRec } from "@maus-inc/utilities";
import type { Transcription } from "@maus-inc/types";
import type { AppState } from "../../state/app.state";
import {
  buildTranscriptionWarnings,
  formatPostProcessModeLabel,
  formatTranscriptionModeLabel,
} from "./transcription-details-copy";

const formatModelSizeLabel = (modelSize?: string | null): ReactNode => {
  const value = modelSize?.trim();
  if (!value) {
    return <FormattedMessage defaultMessage="Unknown" />;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
};

const resolveApiKeyLabel = (
  records: AppState["apiKeyById"],
  apiKeyId: string | null | undefined,
  noneLabel: string,
  unknownLabel: string,
): string => {
  if (!apiKeyId) {
    return noneLabel;
  }

  const record = getRec(records, apiKeyId);
  if (!record) {
    return unknownLabel;
  }

  const suffix = record.keySuffix?.trim();
  if (suffix && suffix.length > 0) {
    return `${record.name} (••••${suffix})`;
  }

  return record.name;
};

const formatTextOrUnknown = (value?: string | null): ReactNode => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? (
    trimmed
  ) : (
    <FormattedMessage defaultMessage="Unknown" />
  );
};

const formatDurationLabel = (ms?: number | null): string | null => {
  if (ms == null) {
    return null;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
};

type TranscriptionRow = Transcription | null | undefined;

export const useTranscriptionModelLabels = ({
  transcription,
  apiKeysById,
}: {
  transcription: TranscriptionRow;
  apiKeysById: AppState["apiKeyById"];
}) => {
  const transcriptionModeLabel = useMemo(
    () => formatTranscriptionModeLabel(transcription?.transcriptionMode),
    [transcription?.transcriptionMode],
  );
  const postProcessModeLabel = useMemo(
    () => formatPostProcessModeLabel(transcription?.postProcessMode),
    [transcription?.postProcessMode],
  );
  const transcriptionApiKeyLabel = useMemo(
    () =>
      resolveApiKeyLabel(
        apiKeysById,
        transcription?.transcriptionApiKeyId,
        "None",
        "Unknown",
      ),
    [apiKeysById, transcription?.transcriptionApiKeyId],
  );
  const postProcessApiKeyLabel = useMemo(
    () =>
      resolveApiKeyLabel(
        apiKeysById,
        transcription?.postProcessApiKeyId,
        "None",
        "Unknown",
      ),
    [apiKeysById, transcription?.postProcessApiKeyId],
  );
  const modelSizeLabel = useMemo(
    () => formatModelSizeLabel(transcription?.modelSize),
    [transcription?.modelSize],
  );
  const deviceLabel = useMemo(
    () => formatTextOrUnknown(transcription?.inferenceDevice),
    [transcription?.inferenceDevice],
  );
  const postProcessDeviceLabel = useMemo(
    () => formatTextOrUnknown(transcription?.postProcessDevice),
    [transcription?.postProcessDevice],
  );
  const postProcessModelLabel = useMemo(
    () => formatTextOrUnknown(transcription?.postProcessModel),
    [transcription?.postProcessModel],
  );

  return {
    transcriptionModeLabel,
    postProcessModeLabel,
    transcriptionApiKeyLabel,
    postProcessApiKeyLabel,
    modelSizeLabel,
    deviceLabel,
    postProcessDeviceLabel,
    postProcessModelLabel,
  };
};

export const useTranscriptionTextLabels = ({
  transcription,
  intl,
}: {
  transcription: TranscriptionRow;
  intl: IntlShape;
}) => {
  const transcriptionPrompt = useMemo(() => {
    const prompt = transcription?.transcriptionPrompt?.trim();
    return prompt && prompt.length > 0 ? prompt : null;
  }, [transcription?.transcriptionPrompt]);
  const rawTranscriptText = useMemo(
    () => transcription?.rawTranscript ?? transcription?.transcript ?? "",
    [transcription?.rawTranscript, transcription?.transcript],
  );
  const sanitizedTranscriptText = useMemo(
    () => transcription?.sanitizedTranscript ?? null,
    [transcription?.sanitizedTranscript],
  );
  const postProcessPrompt = useMemo(() => {
    let prompt = transcription?.postProcessPrompt?.trim() ?? "";
    if (rawTranscriptText) {
      prompt = prompt.replace(rawTranscriptText.trim(), "<transcript>");
    }

    return prompt && prompt.length > 0 ? prompt : null;
  }, [transcription?.postProcessPrompt, rawTranscriptText]);
  const transcriptionDurationLabel = useMemo(
    () => formatDurationLabel(transcription?.transcriptionDurationMs),
    [transcription?.transcriptionDurationMs],
  );
  const postprocessDurationLabel = useMemo(
    () => formatDurationLabel(transcription?.postprocessDurationMs),
    [transcription?.postprocessDurationMs],
  );
  const warnings = useMemo(
    () => buildTranscriptionWarnings(transcription, intl),
    [intl, transcription],
  );

  return {
    transcriptionPrompt,
    rawTranscriptText,
    sanitizedTranscriptText,
    postProcessPrompt,
    transcriptionDurationLabel,
    postprocessDurationLabel,
    warnings,
  };
};
