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
import { FormattedMessage, type IntlShape, useIntl } from "react-intl";
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
import {
  activeRowCheckSx,
  activeRowSx,
  selectedOutlineSx,
} from "../../styles/selection";
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

const getDownloadProgressPercent = (
  progress: number | null | undefined,
): number | null => {
  if (progress == null) {
    return null;
  }
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
};

const formatDownloadProgress = (
  snapshot: LocalSidecarDownloadSnapshot | undefined,
  intl: IntlShape,
): string | null => {
  if (!snapshot) {
    return null;
  }

  const percent = getDownloadProgressPercent(snapshot.progress);
  const progressPart = percent != null ? `${percent}%` : null;

  let bytesPart: string | null = null;
  if (snapshot.totalBytes != null && snapshot.totalBytes > 0) {
    bytesPart = intl.formatMessage(
      {
        defaultMessage: "{downloaded} of {total}",
      },
      {
        downloaded: formatSize(snapshot.bytesDownloaded),
        total: formatSize(snapshot.totalBytes),
      },
    );
  } else if (snapshot.bytesDownloaded > 0) {
    bytesPart = formatSize(snapshot.bytesDownloaded);
  }

  if (progressPart && bytesPart) {
    return `${progressPart} • ${bytesPart}`;
  }

  return progressPart || bytesPart;
};

const formatCompactPercent = (
  snapshot: LocalSidecarDownloadSnapshot | undefined,
): string | null => {
  const percent = getDownloadProgressPercent(snapshot?.progress);
  if (percent == null) {
    return null;
  }
  return `${percent}%`;
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
  isDestructive,
}: {
  deleting?: boolean;
  isDestructive: boolean;
}) => {
  if (deleting) {
    return <FormattedMessage defaultMessage="Deleting..." />;
  }
  if (isDestructive) {
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

type ModelMetaTextProps = {
  helper: string;
  downloading: boolean;
  paused: boolean;
  selectable: boolean;
  validationError: string | null;
};

const ModelMetaText = ({
  helper,
  downloading,
  paused,
  selectable,
  validationError,
}: ModelMetaTextProps) => {
  return (
    <>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: "block",
        }}
      >
        {helper}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        <ModelStatusText
          downloading={downloading}
          paused={paused}
          selectable={selectable}
          validationError={validationError}
        />
      </Typography>
    </>
  );
};

const PausedStatusBadge = ({
  paused,
  compactPercent,
}: {
  paused: boolean;
  compactPercent?: string | null;
}) => {
  if (!paused && !compactPercent) {
    return null;
  }

  const badgeColor = paused ? "warning.main" : "text.secondary";

  const renderBadgeText = () => {
    if (!paused) {
      return compactPercent;
    }
    if (compactPercent) {
      return (
        <FormattedMessage
          defaultMessage="Paused ({percent})"
          values={{ percent: compactPercent }}
        />
      );
    }
    return <FormattedMessage defaultMessage="Paused" />;
  };

  return (
    <Typography
      variant="caption"
      color={badgeColor}
      sx={{
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        mr: 0.5,
      }}
    >
      {renderBadgeText()}
    </Typography>
  );
};

const handleModelClick = (
  event: React.MouseEvent,
  model: LocalWhisperModel,
  action: (m: LocalWhisperModel) => void,
) => {
  event.preventDefault();
  event.stopPropagation();
  action(model);
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
  const primaryAction = paused ? onResume : onPause;

  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: "center",
      }}
    >
      <PausedStatusBadge paused={paused} compactPercent={compactPercent} />
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
        onClick={(e) => handleModelClick(e, model, primaryAction)}
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
        onClick={(e) => handleModelClick(e, model, onCancel)}
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
  const primaryHandler = selectable && onDelete ? onDelete : onDownload;
  const isDestructive = primaryHandler === onDelete && !!onDelete;

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
      onClick={(e) => handleModelClick(e, model, primaryHandler)}
    >
      <ActionButtonLabel deleting={deleting} isDestructive={isDestructive} />
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
  // Fit of the currently selected model against the detected hardware.
  const currentModelFit = capabilities
    ? getModelFit(capabilities, modelValue)
    : null;
  const recommendedModel = capabilities
    ? getRecommendedModel(capabilities)
    : null;
  const recommendedModelOption = LOCAL_MODEL_OPTIONS.find(
    (option) => option.value === recommendedModel,
  );
  const recommendedModelLabel = recommendedModelOption
    ? intl.formatMessage(recommendedModelOption.label)
    : recommendedModel;

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

  const getModelRowState = (option: LocalModelOption) => {
    const value = option.value;
    const status = localTranscriptionConfig.modelStatuses[value];
    const downloadSnapshot = localTranscriptionConfig.modelDownloads[value];
    const downloading =
      isLocalTranscriptionModelDownloadInProgress(downloadSnapshot);
    const paused = isLocalTranscriptionModelDownloadPaused(downloadSnapshot);
    return {
      value,
      label: intl.formatMessage(option.label),
      helper: intl.formatMessage(option.helper),
      status,
      downloadSnapshot,
      downloading,
      paused,
      selectable: isLocalTranscriptionModelSelectable(transcription, value),
      deleting: !!localTranscriptionConfig.modelDeletes[value],
      active: modelValue === value,
    };
  };

  const renderModelMenuItem = (option: LocalModelOption) => {
    const {
      value,
      label,
      helper,
      status,
      downloading,
      paused,
      selectable,
      active,
    } = getModelRowState(option);
    const fit = capabilities ? getModelFit(capabilities, value) : null;
    const showFitWarning =
      fit?.level === "caution" || fit?.level === "discouraged";

    return (
      <MenuItem key={value} value={value} sx={{ ...activeRowSx, py: 1.25 }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              alignItems: "center",
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
              }}
            >
              {label}
            </Typography>
            {showFitWarning && (
              <WarningAmberRoundedIcon
                fontSize="small"
                titleAccess={intl.formatMessage({
                  defaultMessage: "This model may not run well on this device",
                })}
                sx={{
                  color:
                    fit?.level === "discouraged"
                      ? "error.main"
                      : "warning.main",
                }}
              />
            )}
            {active && (
              <CheckRoundedIcon
                fontSize="small"
                sx={activeRowCheckSx}
                titleAccess={intl.formatMessage({ defaultMessage: "Selected" })}
              />
            )}
          </Stack>
          <ModelMetaText
            helper={helper}
            downloading={downloading}
            paused={paused}
            selectable={selectable}
            validationError={status?.validationError || null}
          />
        </Box>
      </MenuItem>
    );
  };

  const renderModelDownloadRow = (option: LocalModelOption) => {
    const {
      value,
      label,
      helper,
      status,
      downloadSnapshot,
      downloading,
      paused,
      selectable,
      deleting,
      active,
    } = getModelRowState(option);
    const progressLabel = formatDownloadProgress(downloadSnapshot, intl);
    const progressPercent = getDownloadProgressPercent(
      downloadSnapshot?.progress,
    );

    return (
      <Box
        key={value}
        sx={(theme) => ({
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          p: 1.25,
          ...(active ? selectedOutlineSx(theme) : null),
        })}
      >
        <Stack spacing={0.75}>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                }}
              >
                {label}
              </Typography>
              <ModelMetaText
                helper={helper}
                downloading={downloading}
                paused={paused}
                selectable={selectable}
                validationError={status?.validationError || null}
              />
            </Box>
            <ModelDownloadActionButtons
              model={value}
              downloading={downloading}
              paused={paused}
              selectable={selectable}
              deleting={deleting}
              compactPercent={formatCompactPercent(downloadSnapshot)}
              onDownload={handleDownloadModel}
              onPause={pauseLocalTranscriptionModelDownload}
              onResume={resumeLocalTranscriptionModelDownload}
              onCancel={cancelLocalTranscriptionModelDownload}
              onDelete={handleDeleteModel}
            />
          </Stack>
          {(downloading || paused) && (
            <LinearProgress
              color={paused ? "warning" : "primary"}
              variant={
                progressPercent != null ? "determinate" : "indeterminate"
              }
              value={progressPercent ?? undefined}
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
      </Box>
    );
  };

  return (
    <Stack
      spacing={3}
      sx={{
        alignItems: "flex-start",
        width: "100%",
      }}
    >
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
                    const isGpu = device.mode === "gpu";
                    const modeLabel = isGpu
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
                  return option ? intl.formatMessage(option.label) : model;
                }}
              >
                <ListSubheader sx={subheaderSx}>
                  <FormattedMessage defaultMessage="NVIDIA NeMo / Sherpa-ONNX (Fast & No Hallucinations)" />
                </ListSubheader>
                {LOCAL_MODEL_OPTIONS.filter(
                  (opt) => opt.category === "fast",
                ).map((opt) => renderModelMenuItem(opt))}

                <ListSubheader sx={subheaderSx}>
                  <FormattedMessage defaultMessage="SenseVoice (Multilingual)" />
                </ListSubheader>
                {LOCAL_MODEL_OPTIONS.filter(
                  (opt) => opt.category === "sherpa",
                ).map((opt) => renderModelMenuItem(opt))}

                <ListSubheader sx={subheaderSx}>
                  <FormattedMessage defaultMessage="OpenAI Whisper (Multilingual GGML)" />
                </ListSubheader>
                {LOCAL_MODEL_OPTIONS.filter(
                  (opt) => opt.category === "whisper",
                ).map((opt) => renderModelMenuItem(opt))}
              </Select>
            </FormControl>

            <Stack spacing={1.25} sx={{ width: "100%" }}>
              <Typography variant="subtitle2">
                <FormattedMessage defaultMessage="Model downloads" />
              </Typography>
              {LOCAL_MODEL_OPTIONS.map(renderModelDownloadRow)}
            </Stack>

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
                  sx={{
                    color: "text.secondary",
                    display: "block",
                  }}
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
                    sx={{
                      color: "warning.main",
                      display: "block",
                    }}
                  >
                    <FormattedMessage defaultMessage="This model may be slow on this device. Consider a smaller model." />
                  </Typography>
                )}
                {currentModelFit?.level === "discouraged" && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "error.main",
                      display: "block",
                    }}
                  >
                    <FormattedMessage defaultMessage="This model is likely too heavy for this device. A smaller model is strongly recommended." />
                  </Typography>
                )}
              </Box>
            )}

            {localTranscriptionConfig.modelStatusesLoading && (
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                }}
              >
                <CircularProgress size={14} />
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
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
