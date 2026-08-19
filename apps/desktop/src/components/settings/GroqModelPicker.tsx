import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import { Box, CircularProgress, Typography } from "@mui/material";
import { secureFetch as fetch } from "../../utils/secure-fetch.utils";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import { FreeSoloModelAutocomplete } from "./FreeSoloModelAutocomplete";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

type GroqModelPickerProps = {
  apiKey: string | null;
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
};

export const GroqModelPicker = ({
  apiKey,
  selectedModel,
  onModelSelect,
  disabled = false,
}: GroqModelPickerProps) => {
  const [models, setModels] = useState<string[]>([]);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchModels = useCallback(async () => {
    if (!apiKey) {
      setModels([]);
      setIsAvailable(null);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(GROQ_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        setIsAvailable(false);
        setModels([]);
        return;
      }

      setIsAvailable(true);
      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>;
      };
      const fetched = (payload.data ?? [])
        .map((m) => (m.id ?? "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      setModels(fetched);
    } catch (error) {
      console.error("Failed to fetch Groq models", error);
      setIsAvailable(false);
      setModels([]);
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  if (!apiKey) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          py: 1,
        }}
      >
        <FormattedMessage defaultMessage="Add an API key to see available models" />
      </Typography>
    );
  }

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
          <FormattedMessage defaultMessage="Loading models..." />
        </Typography>
      </Box>
    );
  }

  if (isAvailable === false) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
        <ErrorOutlineIcon color="error" fontSize="small" />
        <Typography variant="body2" color="error">
          <FormattedMessage defaultMessage="Unable to fetch models from Groq." />
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
