import {
  CheckCircle,
  Copy,
  Download,
  Hourglass,
  Info,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  scheduleTranscriptionDelete,
  undoTranscriptionDelete,
} from "../../utils/pending-transcription-delete";
import { sendTextToActiveRemoteTarget } from "../../actions/remote-output.actions";
import {
  openRetranscribeDialog,
  openTranscriptionDetailsDialog,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import { reducedMotionQuery } from "../../styles/motion";
import { getActiveRemoteTarget } from "../../utils/device.utils";
import { TypographyWithMore } from "../common/TypographyWithMore";
import { AudioPlayerPill } from "./AudioPlayerPill";

export type TranscriptionRowProps = {
  id: string;
};

export const TranscriptionRow = ({ id }: TranscriptionRowProps) => {
  const intl = useIntl();
  const prefersReducedMotion = useMediaQuery(reducedMotionQuery);
  const transcription = useAppStore((state) =>
    getRec(state.transcriptionById, id),
  );

  const hasMetadata = useMemo(() => {
    const model = transcription?.modelSize?.trim();
    const device = transcription?.inferenceDevice?.trim();
    return Boolean(model || device);
  }, [transcription?.inferenceDevice, transcription?.modelSize]);

  const isRetranscribing = useAppStore((state) =>
    state.transcriptions.retranscribingIds.includes(id),
  );
  const didRetranscribe = useAppStore((state) =>
    state.transcriptions.retranscriptionSuccessIds.includes(id),
  );

  const audioSnapshot = transcription?.audio;
  const activeRemoteTarget = useAppStore(getActiveRemoteTarget);
  const isRemoteTranscript = transcription?.remoteStatus === "received";
  const isSentToRemote = transcription?.remoteStatus === "sent";
  const retranscribeTooltip = (() => {
    if (isRetranscribing) {
      return intl.formatMessage({
        defaultMessage: "Retranscribing audio clip",
      });
    }
    if (didRetranscribe) {
      return intl.formatMessage({ defaultMessage: "Retranscribed audio clip" });
    }
    return intl.formatMessage({ defaultMessage: "Retranscribe audio clip" });
  })();

  const retranscribeIcon = (() => {
    if (isRetranscribing && prefersReducedMotion) {
      return (
        <Hourglass
          size={16}
          strokeWidth={1.9}
          aria-hidden
          data-testid="retranscribe-hourglass"
        />
      );
    }
    if (isRetranscribing) {
      return <CircularProgress size={18} color="inherit" aria-hidden />;
    }
    if (didRetranscribe) {
      return (
        <CheckCircle
          size={16}
          strokeWidth={1.9}
          aria-hidden
          data-testid="retranscribe-check"
        />
      );
    }
    return (
      <RotateCcw
        size={16}
        strokeWidth={1.9}
        aria-hidden
        data-testid="retranscribe-replay"
      />
    );
  })();

  const handleDetailsOpen = useCallback(() => {
    openTranscriptionDetailsDialog(id);
  }, [id]);

  const handleCopyTranscript = useCallback(
    async (content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Copied successfully" }),
          { mode: "success" },
        );
      } catch (error) {
        showErrorSnackbar(error);
      }
    },
    [intl],
  );

  const handleDeleteTranscript = useCallback(
    (targetId: string) => {
      const snapshot = transcription;
      if (!snapshot) {
        return;
      }
      const undoWindowMs = 5000;
      try {
        scheduleTranscriptionDelete(snapshot, undoWindowMs);
      } catch {
        showErrorSnackbar(
          intl.formatMessage({
            defaultMessage: "Failed to schedule delete.",
          }),
        );
        return;
      }
      showSnackbar(
        intl.formatMessage({ defaultMessage: "Delete successful" }),
        {
          mode: "success",
          duration: undoWindowMs,
          action: {
            label: intl.formatMessage({ defaultMessage: "Undo" }),
            onClick: () => {
              if (!undoTranscriptionDelete(targetId)) {
                showErrorSnackbar(
                  intl.formatMessage({
                    defaultMessage: "Unable to undo delete.",
                  }),
                );
              }
            },
          },
        },
      );
    },
    [intl, transcription],
  );

  const handleExport = useCallback(async () => {
    try {
      const saved = await invoke<boolean>("export_transcription", { id });
      if (saved) {
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Export saved successfully" }),
          { mode: "success" },
        );
      }
    } catch (error) {
      showErrorSnackbar(error);
    }
  }, [id, intl]);

  const handleSendToReceiver = useCallback(async () => {
    try {
      await sendTextToActiveRemoteTarget(transcription?.transcript || "");
    } catch (error) {
      showErrorSnackbar(error);
    }
  }, [transcription?.transcript]);

  const ctxMenu = useContextMenu();

  const handleCopyId = useCallback(
    async (transcriptionId: string) => {
      try {
        await navigator.clipboard.writeText(transcriptionId);
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Copied successfully" }),
          { mode: "success" },
        );
      } catch (error) {
        showErrorSnackbar(error);
      }
    },
    [intl],
  );

  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: intl.formatMessage({ defaultMessage: "Copy text" }),
        onClick: () => handleCopyTranscript(transcription?.transcript || ""),
      },
      {
        label: intl.formatMessage({ defaultMessage: "Copy ID" }),
        onClick: () => handleCopyId(id),
      },
      {
        label: intl.formatMessage({ defaultMessage: "Open details" }),
        onClick: handleDetailsOpen,
      },
      {
        label: intl.formatMessage({ defaultMessage: "Retranscribe" }),
        onClick: () => openRetranscribeDialog(id),
      },
      { kind: "divider" },
      {
        label: intl.formatMessage({ defaultMessage: "Delete" }),
        danger: true,
        onClick: () => handleDeleteTranscript(id),
      },
    ],
    [
      handleCopyTranscript,
      handleCopyId,
      handleDetailsOpen,
      openRetranscribeDialog,
      handleDeleteTranscript,
      id,
      intl,
      transcription?.transcript,
    ],
  );

  return (
    <Box
      component="div"
      onContextMenu={(e) => {
        // Yield right-clicks on editable text to the provider's clipboard menu.
        if (isEditableTarget(e.target)) return;
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "space-between",
          alignItems: "center",
          mt: 1.5,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Typography
            variant="subtitle2"
            sx={{
              color: "text.secondary",
            }}
          >
            {transcription?.createdAt
              ? new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(transcription.createdAt))
              : ""}
          </Typography>
          {isRemoteTranscript && (
            <Chip
              size="small"
              variant="outlined"
              label={intl.formatMessage({ defaultMessage: "Remote" })}
            />
          )}
          {isSentToRemote && (
            <Chip
              size="small"
              variant="outlined"
              label={intl.formatMessage({ defaultMessage: "Sent" })}
            />
          )}
        </Stack>
        <Stack direction="row" spacing={1}>
          <Tooltip
            title={intl.formatMessage({
              defaultMessage: "View transcription details",
            })}
            placement="top"
          >
            <IconButton
              aria-label={intl.formatMessage({
                defaultMessage: "View transcription details",
              })}
              onClick={handleDetailsOpen}
              size="small"
              color={hasMetadata ? "primary" : "default"}
            >
              <Info size={16} strokeWidth={1.9} />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={intl.formatMessage({ defaultMessage: "Copy transcript" })}
            placement="top"
          >
            <IconButton
              aria-label={intl.formatMessage({
                defaultMessage: "Copy transcript",
              })}
              onClick={() =>
                handleCopyTranscript(transcription?.transcript || "")
              }
              size="small"
            >
              <Copy size={16} strokeWidth={1.9} />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={intl.formatMessage({ defaultMessage: "Delete transcript" })}
            placement="top"
          >
            <IconButton
              aria-label={intl.formatMessage({
                defaultMessage: "Delete transcript",
              })}
              onClick={() => handleDeleteTranscript(id)}
              size="small"
            >
              <Trash2 size={16} strokeWidth={1.9} />
            </IconButton>
          </Tooltip>
          {!isRemoteTranscript && activeRemoteTarget && (
            <Tooltip
              title={intl.formatMessage(
                { defaultMessage: "Send to {name}" },
                { name: activeRemoteTarget.name },
              )}
              placement="top"
            >
              <IconButton
                aria-label={intl.formatMessage(
                  { defaultMessage: "Send to {name}" },
                  { name: activeRemoteTarget.name },
                )}
                onClick={handleSendToReceiver}
                size="small"
              >
                <Send size={16} strokeWidth={1.9} />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
      <TypographyWithMore
        variant="body2"
        color="text.primary"
        maxLines={3}
        sx={{ my: 1 }}
      >
        {transcription?.transcript}
      </TypographyWithMore>
      {audioSnapshot && (
        <AudioPlayerPill
          transcriptionId={id}
          durationMs={audioSnapshot.durationMs}
          disabled={isRetranscribing}
          actions={
            <>
              <Tooltip title={retranscribeTooltip} placement="top">
                <span>
                  <IconButton
                    aria-label={retranscribeTooltip}
                    aria-busy={isRetranscribing}
                    size="small"
                    onClick={() => openRetranscribeDialog(id)}
                    disabled={isRetranscribing}
                    sx={{ p: 0.5 }}
                  >
                    {retranscribeIcon}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip
                title={intl.formatMessage({
                  defaultMessage: "Export transcription",
                })}
                placement="top"
              >
                <IconButton
                  aria-label={intl.formatMessage({
                    defaultMessage: "Export transcription",
                  })}
                  size="small"
                  onClick={handleExport}
                  sx={{ p: 0.5 }}
                >
                  <Download size={16} strokeWidth={1.9} />
                </IconButton>
              </Tooltip>
            </>
          }
        />
      )}
      <Divider sx={{ mt: 2 }} />
      {ctxMenu.renderMenu()}
    </Box>
  );
};
