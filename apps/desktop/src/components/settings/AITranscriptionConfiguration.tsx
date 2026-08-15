import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useEffect } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  refreshLocalTranscriptionDevices,
  deleteLocalTranscriptionModel,
  downloadLocalTranscriptionModel,
  refreshLocalTranscriptionModelStatuses,
} from "../../actions/settings-local-transcription.actions";
import { showErrorSnackbar } from "../../actions/app.actions";
import {
  setPreferredTranscriptionApiKeyId,
  setPreferredTranscriptionDevice,
  setPreferredTranscriptionMode,
  setPreferredTranscriptionModelSize,
} from "../../actions/user.actions";
import {
  isLocalTranscriptionModelDownloadInProgress,
  isLocalTranscriptionModelSelectable,
} from "../../state/settings.state";
import { useAppStore } from "../../store";
import { CPU_DEVICE_VALUE, type TranscriptionMode } from "../../types/ai.types";
import { useSystemCapabilities } from "../../hooks/system-capabilities.hooks";
import {
  formatCapabilitySummary,
  getModelFit,
  getRecommendedModel,
} from "../../utils/model-recommendation.utils";
import { getEffectiveTranscriptionMode } from "../../utils/user.utils";
import { formatSize } from "../../utils/format.utils";
import { type LocalSidecarDownloadSnapshot } from "../../sidecars";
import {
  type LocalWhisperModel,
  normalizeLocalWhisperModel,
} from "../../utils/local-transcription.utils";
import { activeRowCheckSx, activeRowSx } from "../../styles/selection";
import { AnimateSwitch } from "../common/AnimateIn";
import { SegmentedControl } from "../common/SegmentedControl";
import { ApiKeyList } from "./ApiKeyList";

type ModelOption = {
  value: LocalWhisperModel;
  label: string;
  helper: string;
};

const MODEL_OPTIONS: ModelOption[] = [
  {
    value: "tiny",
    label: "Whisper Tiny (77 MB)",
    helper: "Fastest, lowest accuracy",
  },
  {
    value: "base",
    label: "Whisper Base (148 MB)",
    helper: "Great balance of speed and accuracy",
  },
  {
    value: "small",
    label: "Whisper Small (488 MB)",
    helper: "Recommended with GPU acceleration",
  },
  {
    value: "medium",
    label: "Whisper Medium (1.53 GB)",
    helper: "Balanced quality and speed",
  },
  {
    value: "turbo",
    label: "Whisper Large v3 Turbo (1.6 GB)",
    helper: "Fast large model, great accuracy",
  },
  {
    value: "large",
    label: "Whisper Large v3 (3.1 GB)",
    helper: "Highest accuracy, requires GPU",
  },
];

const formatDownloadProgress = (
  snapshot: LocalSidecarDownloadSnapshot | undefined,
): string | null => {
  if (!snapshot) {
    return null;
  }

  const progressPart =
    snapshot.progress != null
      ? `${Math.round(Math.max(0, Math.min(1, snapshot.progress)) * 100)}%`
      : null;

  const bytesPart =
    snapshot.totalBytes != null && snapshot.totalBytes > 0
      ? `${formatSize(snapshot.bytesDownloaded)} of ${formatSize(snapshot.totalBytes)}`
      : snapshot.bytesDownloaded > 0
        ? formatSize(snapshot.bytesDownloaded)
        : null;

  if (progressPart && bytesPart) {
    return `${progressPart} • ${bytesPart}`;
  }

  return progressPart || bytesPart;
};

export const AITranscriptionConfiguration = () => {
  const intl = useIntl();
  const transcription = useAppStore((state) => state.settings.aiTranscription);
  const effectiveMode = useAppStore(getEffectiveTranscriptionMode);
  // Device capabilities drive the model recommendations shown in the local
  // panel (and through the onboarding form that reuses this component).
  const { capabilities } = useSystemCapabilities(effectiveMode === "local");
  const localTranscriptionConfig = transcription.localModelManagement;

  const hasSelectedDevice = transcription.availableDevices.some(
    (device) => device.id === transcription.device,
  );
  const deviceValue = hasSelectedDevice
    ? transcription.device
    : (transcription.availableDevices[0]?.id ?? CPU_DEVICE_VALUE);
  const modelValue = normalizeLocalWhisperModel(transcription.modelSize);
  const modelDownloadSnapshot =
    localTranscriptionConfig.modelDownloads[modelValue];
  const modelDownloading = isLocalTranscriptionModelDownloadInProgress(
    modelDownloadSnapshot,
  );
  const modelSelectable = isLocalTranscriptionModelSelectable(
    transcription,
    modelValue,
  );
  const showInlineModelDownloadAction = !modelSelectable;

  // Fit of the currently selected model against the detected hardware.
  const currentModelFit = capabilities
    ? getModelFit(capabilities, modelValue)
    : null;
  const recommendedModel = capabilities
    ? getRecommendedModel(capabilities)
    : null;
  const recommendedModelLabel =
    MODEL_OPTIONS.find((option) => option.value === recommendedModel)?.label ??
    recommendedModel;

  useEffect(() => {
    if (effectiveMode !== "local") {
      return;
    }

    void refreshLocalTranscriptionDevices();
  }, [effectiveMode]);

  useEffect(() => {
    if (effectiveMode !== "local") {
      return;
    }

    void refreshLocalTranscriptionModelStatuses();
  }, [effectiveMode, transcription.device]);

  useEffect(() => {
    if (
      effectiveMode !== "local" ||
      !localTranscriptionConfig.modelStatusesLoaded
    ) {
      return;
    }

    if (isLocalTranscriptionModelSelectable(transcription, modelValue)) {
      return;
    }

    const fallbackModel = MODEL_OPTIONS.find((option) =>
      isLocalTranscriptionModelSelectable(transcription, option.value),
    )?.value;

    if (!fallbackModel || fallbackModel === modelValue) {
      return;
    }

    void setPreferredTranscriptionModelSize(fallbackModel);
  }, [
    transcription,
    localTranscriptionConfig.modelStatusesLoaded,
    modelValue,
    effectiveMode,
  ]);

  const handleModeChange = useCallback((mode: TranscriptionMode) => {
    void setPreferredTranscriptionMode(mode);
  }, []);

  const handleDeviceChange = useCallback((device: string) => {
    void setPreferredTranscriptionDevice(device);
  }, []);

  const handleModelSizeChange = useCallback(
    (rawModelSize: string) => {
      const modelSize = normalizeLocalWhisperModel(rawModelSize);
      if (!isLocalTranscriptionModelSelectable(transcription, modelSize)) {
        showErrorSnackbar("Download this model before selecting it.");
        return;
      }

      void setPreferredTranscriptionModelSize(modelSize);
    },
    [transcription],
  );

  const handleApiKeyChange = useCallback((id: string | null) => {
    void setPreferredTranscriptionApiKeyId(id);
  }, []);

  const handleDownloadModel = useCallback(
    (model: LocalWhisperModel) => {
      if (
        isLocalTranscriptionModelDownloadInProgress(
          localTranscriptionConfig.modelDownloads[model],
        )
      ) {
        return;
      }

      void downloadLocalTranscriptionModel(model);
    },
    [localTranscriptionConfig.modelDownloads],
  );

  const handleDeleteModel = useCallback(
    (model: LocalWhisperModel) => {
      if (localTranscriptionConfig.modelDeletes[model]) {
        return;
      }

      void (async () => {
        const statuses = await deleteLocalTranscriptionModel(model);
        if (modelValue !== model || !statuses) {
          return;
        }

        const fallbackModel = MODEL_OPTIONS.find(
          (option) =>
            statuses[option.value]?.downloaded && statuses[option.value]?.valid,
        )?.value;

        if (fallbackModel) {
          await setPreferredTranscriptionModelSize(fallbackModel);
        }
      })();
    },
    [localTranscriptionConfig.modelDeletes, modelValue],
  );

  return (
    <Stack spacing={3} alignItems="flex-start" sx={{ width: "100%" }}>
      <SegmentedControl<TranscriptionMode>
        value={effectiveMode}
        onChange={handleModeChange}
        options={[
          { value: "api", label: "API" },
          { value: "local", label: "Local" },
        ]}
        ariaLabel="Processing mode"
        align="center"
      />

      <AnimateSwitch activeKey={effectiveMode}>
        {effectiveMode === "local" && (
          <Stack spacing={3} sx={{ width: "100%" }}>
            <FormControl
              fullWidth
              size="small"
              sx={{ position: "relative" }}
              disabled={transcription.availableDevicesLoading}
            >
              <InputLabel id="processing-device-label">
                <FormattedMessage defaultMessage="Processing device" />
              </InputLabel>
              <Select
                labelId="processing-device-label"
                label={<FormattedMessage defaultMessage="Processing device" />}
                value={deviceValue}
                onChange={(event) =>
                  handleDeviceChange(String(event.target.value))
                }
              >
                {transcription.availableDevices.length === 0 ? (
                  <MenuItem value={CPU_DEVICE_VALUE} disabled>
                    {transcription.availableDevicesLoading
                      ? intl.formatMessage({
                          defaultMessage: "Loading devices...",
                        })
                      : intl.formatMessage({
                          defaultMessage: "No devices available",
                        })}
                  </MenuItem>
                ) : (
                  transcription.availableDevices.map((device) => {
                    const modeLabel =
                      device.mode === "gpu"
                        ? intl.formatMessage({ defaultMessage: "GPU" })
                        : intl.formatMessage({ defaultMessage: "CPU" });

                    return (
                      <MenuItem key={device.id} value={device.id}>
                        {`${modeLabel} • ${device.name}`}
                      </MenuItem>
                    );
                  })
                )}
              </Select>
            </FormControl>

            <FormControl fullWidth size="small">
              <InputLabel id="model-size-label">
                <FormattedMessage defaultMessage="Model size" />
              </InputLabel>
              <Select
                labelId="model-size-label"
                label={<FormattedMessage defaultMessage="Model size" />}
                value={modelValue}
                onChange={(event) =>
                  handleModelSizeChange(String(event.target.value))
                }
                renderValue={(value) => {
                  const model = normalizeLocalWhisperModel(String(value));
                  const option = MODEL_OPTIONS.find(
                    (item) => item.value === model,
                  );
                  return option?.label ?? model;
                }}
                sx={
                  showInlineModelDownloadAction
                    ? {
                        "& .MuiSelect-select": {
                          pr: "132px !important",
                        },
                      }
                    : undefined
                }
              >
                {MODEL_OPTIONS.map(({ value, label, helper }) => {
                  const status = localTranscriptionConfig.modelStatuses[value];
                  const downloadSnapshot =
                    localTranscriptionConfig.modelDownloads[value];
                  const downloading =
                    isLocalTranscriptionModelDownloadInProgress(
                      downloadSnapshot,
                    );
                  const deleting =
                    !!localTranscriptionConfig.modelDeletes[value];
                  const selectable = isLocalTranscriptionModelSelectable(
                    transcription,
                    value,
                  );
                  const progressLabel =
                    formatDownloadProgress(downloadSnapshot);
                  const active = value === modelValue;

                  return (
                    <MenuItem key={value} value={value} sx={activeRowSx}>
                      <Stack spacing={0.75} sx={{ width: "100%" }}>
                        <Stack
                          direction="row"
                          alignItems="center"
                          justifyContent="space-between"
                          gap={1}
                          sx={{ width: "100%" }}
                        >
                          <Box sx={{ minWidth: 0 }}>
                            <Stack
                              direction="row"
                              alignItems="center"
                              gap={0.75}
                            >
                              <Typography variant="body2" fontWeight={600}>
                                {label}
                              </Typography>
                              {(() => {
                                const fit = capabilities
                                  ? getModelFit(capabilities, value)
                                  : null;
                                if (
                                  fit?.level !== "caution" &&
                                  fit?.level !== "discouraged"
                                ) {
                                  return null;
                                }
                                return (
                                  <WarningAmberRoundedIcon
                                    fontSize="small"
                                    titleAccess={intl.formatMessage({
                                      defaultMessage:
                                        "This model may not run well on this device",
                                    })}
                                    sx={{
                                      color:
                                        fit.level === "discouraged"
                                          ? "error.main"
                                          : "warning.main",
                                    }}
                                  />
                                );
                              })()}
                              {active && (
                                <CheckRoundedIcon
                                  fontSize="small"
                                  sx={activeRowCheckSx}
                                  titleAccess={intl.formatMessage({
                                    defaultMessage: "Selected",
                                  })}
                                />
                              )}
                            </Stack>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              display="block"
                            >
                              {helper}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              {selectable
                                ? intl.formatMessage({
                                    defaultMessage: "Downloaded",
                                  })
                                : status?.validationError || null}
                            </Typography>
                          </Box>
                          <Button
                            size="small"
                            variant="contained"
                            color={selectable ? "error" : "primary"}
                            disabled={downloading || deleting}
                            sx={{
                              minWidth: 0,
                              minHeight: 24,
                              px: 1.25,
                              borderRadius: 999,
                              boxShadow: "none",
                              textTransform: "none",
                              fontSize: 12,
                              lineHeight: 1.2,
                              alignSelf: "center",
                              "&:hover": {
                                boxShadow: "none",
                              },
                            }}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (selectable) {
                                handleDeleteModel(value);
                                return;
                              }
                              handleDownloadModel(value);
                            }}
                          >
                            {downloading
                              ? intl.formatMessage({
                                  defaultMessage: "Downloading...",
                                })
                              : deleting
                                ? intl.formatMessage({
                                    defaultMessage: "Deleting...",
                                  })
                                : selectable
                                  ? intl.formatMessage({
                                      defaultMessage: "Delete",
                                    })
                                  : intl.formatMessage({
                                      defaultMessage: "Download",
                                    })}
                          </Button>
                        </Stack>

                        {downloading && (
                          <LinearProgress
                            variant={
                              downloadSnapshot?.progress != null
                                ? "determinate"
                                : "indeterminate"
                            }
                            value={
                              downloadSnapshot?.progress != null
                                ? Math.max(
                                    0,
                                    Math.min(1, downloadSnapshot.progress),
                                  ) * 100
                                : undefined
                            }
                          />
                        )}

                        {downloading && progressLabel && (
                          <Typography variant="caption" color="text.secondary">
                            {progressLabel}
                          </Typography>
                        )}
                      </Stack>
                    </MenuItem>
                  );
                })}
              </Select>
              {showInlineModelDownloadAction && (
                <Box
                  sx={{
                    position: "absolute",
                    right: 36,
                    top: "50%",
                    transform: "translateY(-50%)",
                    zIndex: 1,
                  }}
                >
                  <Button
                    size="small"
                    variant="contained"
                    color="primary"
                    sx={{
                      minWidth: 0,
                      minHeight: 24,
                      px: 1.25,
                      borderRadius: 999,
                      boxShadow: "none",
                      textTransform: "none",
                      fontSize: 12,
                      lineHeight: 1.2,
                      "&:hover": {
                        boxShadow: "none",
                      },
                    }}
                    disabled={modelDownloading}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleDownloadModel(modelValue);
                    }}
                  >
                    {modelDownloading
                      ? intl.formatMessage({ defaultMessage: "Downloading..." })
                      : intl.formatMessage({ defaultMessage: "Download" })}
                  </Button>
                </Box>
              )}
            </FormControl>

            {capabilities && (
              <Box
                sx={{
                  borderRadius: 1.5,
                  bgcolor: "action.hover",
                  border: 1,
                  borderColor: "divider",
                  px: 1.5,
                  py: 1,
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  <FormattedMessage
                    defaultMessage="This device: {summary} · Recommended: {recommended}"
                    values={{
                      summary: formatCapabilitySummary(capabilities),
                      recommended: recommendedModelLabel ?? "",
                    }}
                  />
                </Typography>
                {currentModelFit?.level === "caution" && (
                  <Typography
                    variant="caption"
                    color="warning.main"
                    display="block"
                  >
                    <FormattedMessage defaultMessage="This model may be slow on this device. Consider a smaller model." />
                  </Typography>
                )}
                {currentModelFit?.level === "discouraged" && (
                  <Typography
                    variant="caption"
                    color="error.main"
                    display="block"
                  >
                    <FormattedMessage defaultMessage="This model is likely too heavy for this device. A smaller model is strongly recommended." />
                  </Typography>
                )}
              </Box>
            )}

            {localTranscriptionConfig.modelStatusesLoading && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  <FormattedMessage defaultMessage="Refreshing model status..." />
                </Typography>
              </Stack>
            )}
          </Stack>
        )}

        {effectiveMode === "api" && (
          <ApiKeyList
            selectedApiKeyId={transcription.selectedApiKeyId}
            onChange={handleApiKeyChange}
            context="transcription"
          />
        )}
      </AnimateSwitch>
    </Stack>
  );
};
