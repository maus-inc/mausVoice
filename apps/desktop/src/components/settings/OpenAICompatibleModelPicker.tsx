import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import {
  Autocomplete,
  Box,
  CircularProgress,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";
import { OpenAICompatibleRepo } from "../../repos/ollama.repo";
import { buildOpenAICompatibleUrl } from "../../utils/openai-compatible.utils";
import { createOpenAICompatibleFetch } from "../../utils/secure-fetch.utils";

type OpenAICompatibleModelPickerProps = {
  apiKeyId: string;
  baseUrl: string | null;
  apiKey?: string | null;
  includeV1Path?: boolean | null;
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
};

export const OpenAICompatibleModelPicker = ({
  apiKeyId,
  baseUrl,
  apiKey,
  includeV1Path,
  selectedModel,
  onModelSelect,
  disabled = false,
}: OpenAICompatibleModelPickerProps) => {
  const [models, setModels] = useState<string[]>([]);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [useManualInput, setUseManualInput] = useState(false);

  const effectiveUrl = useMemo(
    () => buildOpenAICompatibleUrl(baseUrl, includeV1Path),
    [baseUrl, includeV1Path],
  );

  // Probes re-arm every 3s only while the endpoint is unavailable — once it
  // answers, polling stops (a 2-call cadence against the native bridge for
  // an open popover is pointless churn). A config change rebuilds the effect
  // and drops the old run's completions via the cancellation flag, so a stale
  // probe can never overwrite fresh state.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      setIsLoading(true);
      try {
        const repo = new OpenAICompatibleRepo(
          effectiveUrl,
          apiKey || undefined,
          createOpenAICompatibleFetch(apiKeyId),
        );
        const available = await repo.checkAvailability();
        if (cancelled) return;

        setIsAvailable(available);
        if (available) {
          const fetchedModels = await repo.getAvailableModels();
          if (cancelled) return;
          setModels(fetchedModels);
          setUseManualInput(false);
          // Endpoint answered: stop polling until the next config change.
          return;
        }
        setModels([]);
        setUseManualInput(true);
        // Endpoint down: probe again shortly (runs are non-overlapping by
        // construction because the next probe is scheduled only after this
        // run settles).
        timer = setTimeout(() => void run(), 3000);
      } catch (error) {
        console.error("Failed to fetch OpenAI-compatible models", error);
        if (!cancelled) {
          setIsAvailable(false);
          setModels([]);
          setUseManualInput(true);
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
  }, [effectiveUrl, apiKey, apiKeyId]);

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
          <FormattedMessage defaultMessage="Checking OpenAI-compatible connection..." />
        </Typography>
      </Box>
    );
  }

  if (isAvailable === false && !useManualInput) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
        <ErrorOutlineIcon color="error" fontSize="small" />
        <Typography variant="body2" color="error">
          <FormattedMessage defaultMessage="Unable to connect to the OpenAI-compatible server at the specified URL." />
        </Typography>
      </Box>
    );
  }

  if (useManualInput) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, py: 1 }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="The server doesn't support model listing. Please enter the model name manually." />
        </Typography>
        <TextField
          label={<FormattedMessage defaultMessage="Model name" />}
          value={selectedModel ?? ""}
          onChange={(event) =>
            onModelSelect(
              event.target.value ? String(event.target.value) : null,
            )
          }
          placeholder="e.g., gpt-4o-mini"
          size="small"
          fullWidth
          disabled={disabled}
        />
      </Box>
    );
  }

  return (
    <Autocomplete
      freeSolo
      options={models}
      value={selectedModel ?? ""}
      onChange={(_event, newValue) => {
        onModelSelect(newValue || null);
      }}
      onInputChange={(_event, newInputValue, reason) => {
        if (reason === "input") {
          onModelSelect(newInputValue || null);
        }
      }}
      disabled={disabled || !isAvailable}
      size="small"
      fullWidth
      renderInput={(params) => (
        <TextField
          {...params}
          label={<FormattedMessage defaultMessage="Model" />}
          placeholder="Select or type a model"
          slotProps={{
            ...params.slotProps,
            inputLabel: { ...params.slotProps.inputLabel, shrink: true },
          }}
        />
      )}
    />
  );
};
