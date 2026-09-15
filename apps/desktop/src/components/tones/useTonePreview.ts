import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREVIEW_SAMPLE_TEXT,
  previewToneStyle,
  TonePreviewFields,
  TonePreviewNoProviderError,
} from "../../actions/tone-preview.actions";

export type TonePreviewStatus =
  "idle" | "running" | "done" | "error" | "unavailable";

export const useTonePreview = () => {
  const [status, setStatus] = useState<TonePreviewStatus>("idle");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(
    async (fields: TonePreviewFields, sampleText: string) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      setStatus("running");
      setError("");
      setOutput("");
      try {
        const text = await previewToneStyle(
          fields,
          sampleText || PREVIEW_SAMPLE_TEXT,
          next.signal,
        );
        if (next.signal.aborted) {
          return;
        }
        setOutput(text);
        setStatus("done");
      } catch (caught) {
        if (next.signal.aborted) {
          setStatus("idle");
          return;
        }
        if (caught instanceof TonePreviewNoProviderError) {
          setStatus("unavailable");
          return;
        }
        setError(caught instanceof Error ? caught.message : "Preview failed.");
        setStatus("error");
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { status, output, error, run, cancel };
};
