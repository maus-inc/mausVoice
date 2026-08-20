import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { OllamaRepo, OpenAICompatibleRepo } from "../../repos/ollama.repo";
import { OLLAMA_DEFAULT_URL } from "../../utils/ollama.utils";
import { buildOpenAICompatibleUrl } from "../../utils/openai-compatible.utils";
import { FreeSoloModelAutocomplete } from "./FreeSoloModelAutocomplete";

type OllamaModelPickerProps = {
  baseUrl: string | null;
  apiKey?: string | null;
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
  provider?: "ollama" | "openai-compatible";
};

export const OllamaModelPicker = ({
  baseUrl,
  apiKey,
  selectedModel,
  onModelSelect,
  disabled = false,
  provider = "ollama",
}: OllamaModelPickerProps) => {
  const [models, setModels] = useState<string[]>([]);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const effectiveUrl = baseUrl || OLLAMA_DEFAULT_URL;

  // One a request at a time, with stale results dropped: a slow endpoint
  // must not stack concurrent probes, and a response from the previous URL
  // must not overwrite the picker's current state.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      setIsLoading(true);
      try {
        const repo =
          provider === "openai-compatible"
            ? // The OpenAI-compatible probe lives under /v1 like the rest of
              // the provider's calls; skip the suffix for a plain Ollama host.
              new OpenAICompatibleRepo(
                buildOpenAICompatibleUrl(effectiveUrl),
                apiKey || undefined,
              )
            : new OllamaRepo(effectiveUrl, apiKey || undefined);
        const available = await repo.checkAvailability();
        if (cancelled) return;
        setIsAvailable(available);

        if (available) {
          const fetchedModels = await repo.getAvailableModels();
          if (cancelled) return;
          setModels(fetchedModels);
        } else {
          setModels([]);
        }
      } catch (error) {
        console.error("Failed to fetch Ollama models", error);
        if (!cancelled) {
          setIsAvailable(false);
          setModels([]);
        }
      } finally {
        inFlight = false;
        if (!cancelled) setIsLoading(false);
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [effectiveUrl, apiKey, provider]);

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
