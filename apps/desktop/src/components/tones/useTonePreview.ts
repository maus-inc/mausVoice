import { useCallback, useEffect, useRef, useState } from "react";
import {
  previewToneStyle,
  TonePreviewFields,
  TonePreviewNoProviderError,
} from "../../actions/tone-preview.actions";

export type TonePreviewStatus =
  "idle" | "running" | "done" | "error" | "unavailable";

export const useTonePreview = (defaultSampleText: string) => {
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
          sampleText || defaultSampleText,
          next.signal,
        );
        if (controller.current !== next || next.signal.aborted) {
          return;
        }
        setOutput(text);
        setStatus("done");
      } catch (error_) {
        if (controller.current !== next || next.signal.aborted) {
          return;
        }
        if (error_ instanceof TonePreviewNoProviderError) {
          setStatus("unavailable");
          return;
        }
        setError(error_ instanceof Error ? error_.message : "");
        setStatus("error");
      } finally {
        if (controller.current === next) controller.current = null;
      }
    },
    [defaultSampleText],
  );

  const cancel = useCallback(() => {
    const current = controller.current;
    controller.current = null;
    current?.abort();
    setStatus("idle");
    setOutput("");
    setError("");
  }, []);

  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  return { status, output, error, run, cancel };
};
