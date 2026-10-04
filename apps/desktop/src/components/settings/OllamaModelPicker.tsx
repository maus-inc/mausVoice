import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { OllamaRepo } from "../../repos/ollama.repo";
import { OLLAMA_DEFAULT_URL } from "../../utils/ollama.utils";
import { withTimeout } from "../../utils/timeout.utils";
import { FreeSoloModelAutocomplete } from "./FreeSoloModelAutocomplete";

/**
 * A stalled Ollama endpoint must not wedge the probe; see the effect below. `OllamaRepo`
 * issues no request with a timeout or an AbortSignal of its own.
 */
const PROBE_TIMEOUT_MS = 10_000;

// This picker is Ollama-only: OpenAI-compatible providers route to
// OpenAICompatibleModelPicker instead (which carries the authorized
// saved-endpoint fetch and /v1 handling). Keeping a dormant compat branch
// here would probe the wrong transport if it were ever revived.
type OllamaModelPickerProps = {
  baseUrl: string | null;
  apiKey?: string | null;
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
};

export const OllamaModelPicker = ({
  baseUrl,
  apiKey,
  selectedModel,
  onModelSelect,
  disabled = false,
}: OllamaModelPickerProps) => {
  const [models, setModels] = useState<string[]>([]);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const effectiveUrl = baseUrl || OLLAMA_DEFAULT_URL;

  // Probes re-arm every 3s only while the endpoint is unavailable; once it
  // answers, polling stops (the models list is in-hand and a config change
  // rebuilds the effect anyway). Runs never overlap by construction: the next
  // probe is scheduled only after the current one settles, and its late
  // result is discarded by the cancellation flag.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One controller for the whole effect. `withTimeout` stops WAITING on a host that
    // accepts the connection and then stalls; it does not stop the request, so
    // without this every 3s retry armed another live probe and they accumulated.
    // The timeout path and the unmount/endpoint-change path both abort it.
    const controller = new AbortController();

    // A new endpoint or key means the previous answer describes a DIFFERENT server, so it is
    // cleared here rather than left for the first `await` to overwrite.
    //
    // Without this the picker kept rendering the old answer for the whole probe round: the
    // "Checking…" branch is `isLoading && isAvailable === null`, and `isAvailable` was still the
    // old `true`, so the branch was skipped, the stale model list stayed on screen, and
    // `disabled={disabled || !isAvailable}` left the select ENABLED -- you could pick a model
    // that does not exist on the endpoint just typed.
    setIsAvailable(null);
    setModels([]);

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      setIsLoading(true);
      try {
        const repo = new OllamaRepo(effectiveUrl, apiKey || undefined);
        // Bounded, because `OllamaRepo` has no timeout and no AbortSignal. A host that accepts
        // the connection and then stalls -- a wrong address behind a firewall that DROPs, a
        // tunnel that never answers -- left the `await` pending forever: `inFlight` stayed true
        // so no retry was armed, `finally` never ran, and the probe could not be recovered
        // without editing the URL to rebuild the effect. Rejecting instead lands in the catch
        // below and re-arms the 3s retry like any other failure.
        const available = await withTimeout(
          repo.checkAvailability(controller.signal),
          PROBE_TIMEOUT_MS,
          "Ollama availability probe",
          () => controller.abort(),
        );
        if (cancelled) return;
        setIsAvailable(available);

        if (available) {
          const fetchedModels = await withTimeout(
            repo.getAvailableModels(controller.signal),
            PROBE_TIMEOUT_MS,
            "Ollama model list",
            () => controller.abort(),
          );
          if (cancelled) return;
          setModels(fetchedModels);
          return;
        }
        setModels([]);
        timer = setTimeout(() => void run(), 3000);
      } catch (error) {
        console.error("Failed to fetch Ollama models", error);
        if (!cancelled) {
          setIsAvailable(false);
          setModels([]);
          timer = setTimeout(() => void run(), 3000);
        }
      } finally {
        inFlight = false;
        if (!cancelled) setIsLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [effectiveUrl, apiKey]);

  if (isLoading && isAvailable === null) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
        <CircularProgress size={16} />
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="Checking Ollama connection..." />
        </Typography>
      </Box>
    );
  }

  if (isAvailable === false) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
        <ErrorOutlineIcon color="error" fontSize="small" />
        <Typography variant="body2" color="error">
          <FormattedMessage defaultMessage="Unable to connect to Ollama at the specified URL." />
        </Typography>
      </Box>
    );
  }

  return (
    <FreeSoloModelAutocomplete
      models={models}
      selectedModel={selectedModel}
      onModelSelect={onModelSelect}
      disabled={disabled || !isAvailable}
    />
  );
};
