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
import {
  createOpenAICompatibleFetch,
  secureFetch,
} from "../../utils/secure-fetch.utils";

type OpenAICompatibleModelPickerProps = {
  apiKeyId: string;
  baseUrl: string | null;
  apiKey?: string | null;
  includeV1Path?: boolean | null;
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  disabled?: boolean;
};

/** How long one probe may run before it is abandoned and retried. */
export const PROBE_TIMEOUT_MS = 10_000;
/** How long to wait before probing an unavailable endpoint again. */
export const PROBE_RETRY_MS = 3000;

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

  /**
   * `createOpenAICompatibleFetch` authorizes every request against the base URL
   * already saved on this API-key row, and rejects the call outright when that
   * column is null. A key persisted before the column existed still has none,
   * and `buildOpenAICompatibleUrl` legitimately resolves those to the documented
   * local default, so probing them through the saved-endpoint fetch could only
   * ever fail. They go through the normal private fetch instead, which accepts
   * the same loopback and RFC1918 targets.
   */
  const hasSavedEndpoint = Boolean(baseUrl?.trim());
  const fetchForEndpoint = useMemo(
    () =>
      hasSavedEndpoint ? createOpenAICompatibleFetch(apiKeyId) : secureFetch,
    [apiKeyId, hasSavedEndpoint],
  );

  // Probes re-arm every 3s only while the endpoint is unavailable — once it
  // answers, polling stops (a 2-call cadence against the native bridge for
  // an open popover is pointless churn). A config change rebuilds the effect
  // and drops the old run's completions via the cancellation flag, so a stale
  // probe can never overwrite fresh state.
  //
  // Each probe is also bounded. The next one is only scheduled after the current
  // run settles, so a `/models` request that never answered held the retry for
  // as long as the network kept it open, and the picker sat on its initial
  // "Checking OpenAI-compatible connection..." indicator the whole time.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Counts the runs this effect has started. The deadline does not merely stop
    // waiting on a run: it retires it by advancing this counter, so a request
    // that answers minutes later resumes into a guard that is already false and
    // writes nothing. Without the retirement the late continuation would clear
    // the newer run's deadline and overwrite its verdict.
    let currentRun = 0;

    /** Ends this run's deadline, which a settled run no longer needs. */
    const clearDeadline = () => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
    };

    const run = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const runId = ++currentRun;
      /** False once this run has been retired by its deadline or a config change. */
      const isCurrent = () => !cancelled && runId === currentRun;
      setIsLoading(true);
      // Armed before the first await, so a request that never settles is
      // abandoned on time rather than blocking the retry indefinitely.
      deadline = setTimeout(() => {
        currentRun += 1;
        inFlight = false;
        setIsAvailable(false);
        setModels([]);
        setUseManualInput(true);
        if (cancelled) return;
        setIsLoading(false);
        timer = setTimeout(() => void run(), PROBE_RETRY_MS);
      }, PROBE_TIMEOUT_MS);
      try {
        const repo = new OpenAICompatibleRepo(
          effectiveUrl,
          apiKey || undefined,
          fetchForEndpoint,
        );
        const available = await repo.checkAvailability();
        if (!isCurrent()) return;
        clearDeadline();

        setIsAvailable(available);
        if (available) {
          const fetchedModels = await repo.getAvailableModels();
          if (!isCurrent()) return;
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
        timer = setTimeout(() => void run(), PROBE_RETRY_MS);
      } catch (error) {
        console.error("Failed to fetch OpenAI-compatible models", error);
        if (!isCurrent()) return;
        clearDeadline();
        setIsAvailable(false);
        setModels([]);
        setUseManualInput(true);
        timer = setTimeout(() => void run(), PROBE_RETRY_MS);
      } finally {
        // Only the live run owns `inFlight` and the loading indicator; a retired
        // run must not release the newer run's hold on either, which would let a
        // third probe start alongside it.
        if (isCurrent()) {
          inFlight = false;
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearDeadline();
    };
  }, [effectiveUrl, apiKey, apiKeyId, fetchForEndpoint]);

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
