import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { PREVIEW_SAMPLE_MESSAGE } from "./tone-form.utils";
import { useTonePreview } from "./useTonePreview";

/** Keep a preview tied to the sample and exact style fields that produced it. */
export const useToneDraftPreview = ({
  promptTemplate,
  category,
  outputLength,
  exampleInputOutput,
}: {
  promptTemplate: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
}) => {
  const intl = useIntl();
  const defaultSampleText = intl.formatMessage(PREVIEW_SAMPLE_MESSAGE);
  const [sampleText, setSampleText] = useState(() => defaultSampleText);
  const preview = useTonePreview(defaultSampleText);

  // Invalidate completed results and in-flight requests, without auto-running
  // on each keystroke. The create wizard separately runs on entering review.
  useEffect(preview.cancel, [
    preview.cancel,
    sampleText,
    promptTemplate,
    category,
    outputLength,
    exampleInputOutput,
  ]);

  const fields = useMemo(
    () => ({
      promptTemplate: promptTemplate.trim(),
      category: category.trim() || undefined,
      outputLength: outputLength.trim() || undefined,
      exampleInputOutput: exampleInputOutput.trim() || undefined,
    }),
    [promptTemplate, category, outputLength, exampleInputOutput],
  );

  return { sampleText, setSampleText, preview, fields };
};
