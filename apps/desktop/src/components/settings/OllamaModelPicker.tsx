import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { OllamaRepo } from "../../repos/ollama.repo";
import { OLLAMA_DEFAULT_URL } from "../../utils/ollama.utils";
import { FreeSoloModelAutocomplete } from "./FreeSoloModelAutocomplete";

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

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      setIsLoading(true);
      try {
        const repo = new OllamaRepo(effectiveUrl, apiKey || undefined);
        const available = await repo.checkAvailability();
        if (cancelled) return;
        setIsAvailable(available);

        if (available) {
          const fetchedModels = await repo.getAvailableModels();
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
