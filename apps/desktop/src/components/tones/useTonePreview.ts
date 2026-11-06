import { unknownToMessage } from "@maus-inc/utilities";
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
      const isObsolete = () =>
        controller.current !== next || next.signal.aborted;
      setStatus("running");
      setError("");
      setOutput("");
      try {
        const text = await previewToneStyle(
          fields,
          sampleText || defaultSampleText,
          next.signal,
        );
        if (isObsolete()) {
          return;
        }
        setOutput(text);
        setStatus("done");
      } catch (error_) {
        if (isObsolete()) {
          return;
        }
        if (error_ instanceof TonePreviewNoProviderError) {
          setStatus("unavailable");
          return;
        }
        setError(error_ instanceof Error ? unknownToMessage(error_) : "");
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
