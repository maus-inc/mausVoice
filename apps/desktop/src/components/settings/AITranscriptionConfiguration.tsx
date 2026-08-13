import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  LinearProgress,
  ListSubheader,
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
  pauseLocalTranscriptionModelDownload,
  resumeLocalTranscriptionModelDownload,
  cancelLocalTranscriptionModelDownload,
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
  isLocalTranscriptionModelDownloadPaused,
  isLocalTranscriptionModelSelectable,
  type SettingsTranscriptionState,
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
  type LocalModelOption,
  LOCAL_MODEL_OPTIONS,
  type LocalWhisperModel,
  normalizeLocalWhisperModel,
} from "../../utils/local-transcription.utils";
import { activeRowCheckSx, activeRowSx } from "../../styles/selection";
import { duration, easeOutCubic } from "../../styles/motion";
import { AnimateSwitch } from "../common/AnimateIn";
import { SegmentedControl } from "../common/SegmentedControl";
import { ApiKeyList } from "./ApiKeyList";

const ease = `cubic-bezier(${easeOutCubic.join(", ")})`;
const buttonTransition = `background-color ${duration.fast}s ${ease}, border-color ${duration.fast}s ${ease}, transform ${duration.instant}s ${ease}`;

const buttonSx = {
  transition: buttonTransition,
  "&:active": {
    transform: "scale(0.97)",
  },
};

const subheaderSx = {
  bgcolor: "background.paper",
  lineHeight: "28px",
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "text.secondary",
} as const;

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

const formatCompactPercent = (
  snapshot: LocalSidecarDownloadSnapshot | undefined,
): string | null => {
  if (snapshot?.progress == null) {
    return null;
  }
  return `${Math.round(Math.max(0, Math.min(1, snapshot.progress)) * 100)}%`;
};

const resolveDeviceSelectValue = (
  transcription: SettingsTranscriptionState,
): string => {
  const hasSelected = transcription.availableDevices.some(
    (device) => device.id === transcription.device,
  );
  if (hasSelected) {
    return transcription.device;
  }
  const fallback = transcription.availableDevices[0]?.id;
  return fallback ?? CPU_DEVICE_VALUE;
};

const ActionButtonLabel = ({
  deleting,
  selectable,
}: {
  deleting?: boolean;
  selectable: boolean;
}) => {
  if (deleting) {
    return <FormattedMessage defaultMessage="Deleting..." />;
  }
  if (selectable) {
    return <FormattedMessage defaultMessage="Delete" />;
  }
  return <FormattedMessage defaultMessage="Download" />;
};

const ModelStatusText = ({
  downloading,
  paused,
  selectable,
  validationError,
}: {
  downloading: boolean;
  paused: boolean;
  selectable: boolean;
  validationError: string | null;
}) => {
  if (downloading) {
    return <FormattedMessage defaultMessage="Downloading..." />;
  }
  if (paused) {
    return <FormattedMessage defaultMessage="Paused" />;
  }
  if (selectable) {
    return <FormattedMessage defaultMessage="Downloaded" />;
  }
  return <>{validationError}</>;
};

const resolveBadgeLabel = (
  paused: boolean,
  compactPercent?: string | null,
): string | null => {
  if (!paused) {
    return compactPercent ?? null;
  }
  if (compactPercent) {
    return `Paused (${compactPercent})`;
  }
  return "Paused";
};

const BusyDownloadButtons = ({
  model,
  paused,
  compactPercent,
  onPause,
  onResume,
  onCancel,
}: {
  model: LocalWhisperModel;
  paused: boolean;
  compactPercent?: string | null;
  onPause: (model: LocalWhisperModel) => void;
  onResume: (model: LocalWhisperModel) => void;
  onCancel: (model: LocalWhisperModel) => void;
}) => {
  const trigger = (
    event: React.MouseEvent,
    action: (m: LocalWhisperModel) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    action(model);
  };

  const primaryAction = paused ? onResume : onPause;
  const badgeColor = paused ? "warning.main" : "text.secondary";
  const badgeLabel = resolveBadgeLabel(paused, compactPercent);

  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      {badgeLabel && (
        <Typography
          variant="caption"
          fontWeight={600}
          color={badgeColor}
          sx={{ fontVariantNumeric: "tabular-nums", mr: 0.5 }}
        >
          {badgeLabel}
        </Typography>
      )}
      <Button
        size="small"
        variant={paused ? "contained" : "outlined"}
        color={paused ? "primary" : "warning"}
        startIcon={
          paused ? (
            <PlayArrowRoundedIcon sx={{ fontSize: 14 }} />
          ) : (
            <PauseRoundedIcon sx={{ fontSize: 14 }} />
          )
        }
        sx={{
          ...buttonSx,
          minWidth: 0,
          minHeight: 24,
          px: 1,
          borderRadius: 999,
          textTransform: "none",
          fontSize: 12,
          lineHeight: 1.2,
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => trigger(e, primaryAction)}
      >
        {paused ? (
          <FormattedMessage defaultMessage="Resume" />
        ) : (
          <FormattedMessage defaultMessage="Pause" />
        )}
      </Button>
      <Button
        size="small"
        variant="text"
        color="inherit"
        startIcon={<CloseRoundedIcon sx={{ fontSize: 14 }} />}
        sx={{
          ...buttonSx,
          minWidth: 0,
          minHeight: 24,
          px: 1,
          borderRadius: 999,
          textTransform: "none",
          fontSize: 12,
          lineHeight: 1.2,
          color: "text.secondary",
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => trigger(e, onCancel)}
      >
        <FormattedMessage defaultMessage="Cancel" />
      </Button>
    </Stack>
  );
};

const IdleDownloadButton = ({
  model,
  selectable,
  deleting,
  onDownload,
  onDelete,
}: {
  model: LocalWhisperModel;
  selectable: boolean;
  deleting?: boolean;
  onDownload: (model: LocalWhisperModel) => void;
  onDelete?: (model: LocalWhisperModel) => void;
}) => {
  const trigger = (
    event: React.MouseEvent,
    action: (m: LocalWhisperModel) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    action(model);
  };

  const isDestructive = selectable;
  const primaryHandler = isDestructive && onDelete ? onDelete : onDownload;

  return (
    <Button
      size="small"
      variant="contained"
      color={isDestructive ? "error" : "primary"}
      disabled={deleting}
      sx={{
        ...buttonSx,
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
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => trigger(e, primaryHandler)}
    >
      <ActionButtonLabel deleting={deleting} selectable={selectable} />
    </Button>
  );
};

type ModelDownloadActionButtonsProps = {
  model: LocalWhisperModel;
  downloading: boolean;
  paused: boolean;
  selectable: boolean;
  deleting?: boolean;
  compactPercent?: string | null;
  onDownload: (model: LocalWhisperModel) => void;
  onPause: (model: LocalWhisperModel) => void;
  onResume: (model: LocalWhisperModel) => void;
  onCancel: (model: LocalWhisperModel) => void;
  onDelete?: (model: LocalWhisperModel) => void;
};

const ModelDownloadActionButtons = ({
  model,
  downloading,
  paused,
  selectable,
  deleting,
  compactPercent,
  onDownload,
  onPause,
  onResume,
  onCancel,
  onDelete,
}: ModelDownloadActionButtonsProps) => {
  if (downloading || paused) {
    return (
      <BusyDownloadButtons
        model={model}
        paused={paused}
        compactPercent={compactPercent}
        onPause={onPause}
        onResume={onResume}
        onCancel={onCancel}
      />
    );
  }

  return (
    <IdleDownloadButton
      model={model}
      selectable={selectable}
      deleting={deleting}
      onDownload={onDownload}
      onDelete={onDelete}
    />
  );
};

export const AITranscriptionConfiguration = () => {
  const intl = useIntl();
  const transcription = useAppStore((state) => state.settings.aiTranscription);
  const effectiveMode = useAppStore(getEffectiveTranscriptionMode);
  // Device capabilities drive the model recommendations shown in the local
  // panel (and through the onboarding form that reuses this component).
  const { capabilities } = useSystemCapabilities(effectiveMode === "local");
  const localTranscriptionConfig = transcription.localModelManagement;

  const deviceValue = resolveDeviceSelectValue(transcription);
  const modelValue = normalizeLocalWhisperModel(transcription.modelSize);
  const modelDownloadSnapshot =
    localTranscriptionConfig.modelDownloads[modelValue];
  const modelDownloading = isLocalTranscriptionModelDownloadInProgress(
    modelDownloadSnapshot,
  );
  const modelPaused = isLocalTranscriptionModelDownloadPaused(
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
    LOCAL_MODEL_OPTIONS.find((option) => option.value === recommendedModel)
      ?.label ?? recommendedModel;

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

    const fallbackModel = LOCAL_MODEL_OPTIONS.find((option) =>
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

        const fallbackModel = LOCAL_MODEL_OPTIONS.find(
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

  const renderModelMenuItem = (option: LocalModelOption) => {
    const { value, label, helper } = option;
    const status = localTranscriptionConfig.modelStatuses[value];
    const downloadSnapshot = localTranscriptionConfig.modelDownloads[value];
    const deleting = !!localTranscriptionConfig.modelDeletes[value];
    const downloading =
      isLocalTranscriptionModelDownloadInProgress(downloadSnapshot);
    const paused = isLocalTranscriptionModelDownloadPaused(downloadSnapshot);
    const selectable = isLocalTranscriptionModelSelectable(
      transcription,
      value,
    );
    const active = modelValue === value;
    const progressLabel = formatDownloadProgress(downloadSnapshot);

    return (
      <MenuItem
        key={value}
        value={value}
        sx={{
          ...activeRowSx,
          alignItems: "stretch",
          py: 1.25,
        }}
      >
        <Stack spacing={0.75} sx={{ width: "100%" }}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="flex-start"
            spacing={1.5}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" alignItems="center" spacing={0.5}>
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
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                <ModelStatusText
                  downloading={downloading}
                  paused={paused}
                  selectable={selectable}
                  validationError={status?.validationError || null}
                />
              </Typography>
            </Box>

            <Box sx={{ alignSelf: "center" }}>
              <ModelDownloadActionButtons
                model={value}
                downloading={downloading}
                paused={paused}
                selectable={selectable}
                deleting={deleting}
                onDownload={handleDownloadModel}
                onPause={pauseLocalTranscriptionModelDownload}
                onResume={resumeLocalTranscriptionModelDownload}
                onCancel={cancelLocalTranscriptionModelDownload}
                onDelete={handleDeleteModel}
              />
            </Box>
          </Stack>

          {(downloading || paused) && (
            <LinearProgress
              color={paused ? "warning" : "primary"}
              variant={
                downloadSnapshot?.progress != null
                  ? "determinate"
                  : "indeterminate"
              }
              value={
                downloadSnapshot?.progress != null
                  ? Math.max(0, Math.min(1, downloadSnapshot.progress)) * 100
                  : undefined
              }
              sx={{ borderRadius: 999, height: 4 }}
            />
          )}

          {(downloading || paused) && progressLabel && (
            <Typography
              variant="caption"
              color={paused ? "warning.main" : "text.secondary"}
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {paused
                ? `${intl.formatMessage({ defaultMessage: "Paused" })} • ${progressLabel}`
                : progressLabel}
            </Typography>
          )}
        </Stack>
      </MenuItem>
    );
  };

  const compactPercent = formatCompactPercent(modelDownloadSnapshot);

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
                        {device.name} ({modeLabel})
                      </MenuItem>
                    );
                  })
                )}
              </Select>
            </FormControl>

            <FormControl fullWidth size="small" sx={{ position: "relative" }}>
              <InputLabel id="transcription-model-label">
                <FormattedMessage defaultMessage="Transcription model" />
              </InputLabel>
              <Select
                labelId="transcription-model-label"
                label={
                  <FormattedMessage defaultMessage="Transcription model" />
                }
                value={modelValue}
                onChange={(event) =>
                  handleModelSizeChange(String(event.target.value))
                }
                renderValue={(value) => {
                  const model = normalizeLocalWhisperModel(String(value));
                  const option = LOCAL_MODEL_OPTIONS.find(
                    (item) => item.value === model,
                  );
                  return option?.label || model;
                }}
                sx={
                  showInlineModelDownloadAction
                    ? {
                        "& .MuiSelect-select": {
                          pr: "180px !important",
                        },
                      }
                    : undefined
                }
              >
                <ListSubheader sx={subheaderSx}>
                  <FormattedMessage defaultMessage="NVIDIA NeMo / Sherpa-ONNX (Fast & No Hallucinations)" />
                </ListSubheader>
                {LOCAL_MODEL_OPTIONS.filter(
                  (opt) => opt.category === "fast",
                ).map((opt) => renderModelMenuItem(opt))}

                <ListSubheader sx={subheaderSx}>
                  <FormattedMessage defaultMessage="OpenAI Whisper (Multilingual GGML)" />
                </ListSubheader>
                {LOCAL_MODEL_OPTIONS.filter(
                  (opt) => opt.category === "whisper",
                ).map((opt) => renderModelMenuItem(opt))}
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
                  <ModelDownloadActionButtons
                    model={modelValue}
                    downloading={modelDownloading}
                    paused={modelPaused}
                    selectable={modelSelectable}
                    compactPercent={compactPercent}
                    onDownload={handleDownloadModel}
                    onPause={pauseLocalTranscriptionModelDownload}
                    onResume={resumeLocalTranscriptionModelDownload}
                    onCancel={cancelLocalTranscriptionModelDownload}
                  />
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
