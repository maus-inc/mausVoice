import { Copy, Download, Info, Send, Trash2 } from "lucide-react";
import {
  Box,
  Chip,
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
import {
  cssEase,
  duration,
  easeOutQuint,
  reducedMotionQuery,
} from "../../styles/motion";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
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
import { getActiveRemoteTarget } from "../../utils/device.utils";
import { TypographyWithMore } from "../common/TypographyWithMore";
import { AudioPlayerPill } from "./AudioPlayerPill";
import { RetranscribeAction } from "./RetranscribeAction";
import { useTranscriptionDeleteUndo } from "./useTranscriptionDeleteUndo";

export type TranscriptionRowProps = {
  id: string;
};

/**
 * One icon button in the row's action cluster, with its tooltip.
 *
 * Extracted so the four row actions read as one line each instead of a
 * Tooltip>IconButton pair nested four JSX levels deep inside the row's
 * Box>Box>Stack>Stack. `label` is passed already formatted by the caller, so
 * every `defaultMessage` literal stays in this module where the extractor can
 * read it, and `title`/`aria-label` stay the same string as before.
 */
const RowAction = ({
  label,
  onClick,
  icon,
  color,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  color?: "primary" | "default";
}) => (
  <Tooltip title={label} placement="top">
    <IconButton aria-label={label} onClick={onClick} size="small" color={color}>
      {icon}
    </IconButton>
  </Tooltip>
);

type TranscriptionRowHeaderProps = {
  createdAt: string | undefined;
  isRemoteTranscript: boolean;
  isSentToRemote: boolean;
  hasMetadata: boolean;
  activeRemoteTarget: ReturnType<typeof getActiveRemoteTarget>;
  onDetailsOpen: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onSend: () => void;
};

const TranscriptionRowHeader = ({
  createdAt,
  isRemoteTranscript,
  isSentToRemote,
  hasMetadata,
  activeRemoteTarget,
  onDetailsOpen,
  onCopy,
  onDelete,
  onSend,
}: TranscriptionRowHeaderProps) => {
  const intl = useIntl();
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        justifyContent: "space-between",
        alignItems: "center",
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
          {createdAt
            ? new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(createdAt))
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
        <RowAction
          label={intl.formatMessage({
            defaultMessage: "View transcription details",
          })}
          onClick={onDetailsOpen}
          icon={<Info size={16} strokeWidth={1.9} />}
          color={hasMetadata ? "primary" : "default"}
        />
        <RowAction
          label={intl.formatMessage({ defaultMessage: "Copy transcript" })}
          onClick={onCopy}
          icon={<Copy size={16} strokeWidth={1.9} />}
        />
        <RowAction
          label={intl.formatMessage({
            defaultMessage: "Delete transcript",
          })}
          onClick={onDelete}
          icon={<Trash2 size={16} strokeWidth={1.9} />}
        />
        {!isRemoteTranscript && activeRemoteTarget && (
          <RowAction
            label={intl.formatMessage(
              { defaultMessage: "Send to {name}" },
              { name: activeRemoteTarget.name },
            )}
            onClick={onSend}
            icon={<Send size={16} strokeWidth={1.9} />}
          />
        )}
      </Stack>
    </Stack>
  );
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

  const handleDetailsOpen = useCallback(() => {
    openTranscriptionDetailsDialog(id);
  }, [id]);

  const handleCopyText = useCallback(
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

  const handleDeleteTranscript = useTranscriptionDeleteUndo(transcription);

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

  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: intl.formatMessage({ defaultMessage: "Copy text" }),
        onClick: () => handleCopyText(transcription?.transcript || ""),
      },
      {
        label: intl.formatMessage({ defaultMessage: "Copy ID" }),
        onClick: () => handleCopyText(id),
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
      handleCopyText,
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
      {/* One hit area per item: the hover wash covers the date row, the
          transcript, and the audio pill together — never the date column
          alone. The divider stays outside so rows keep a clean seam. */}
      <Box
        sx={{
          mt: 1.5,
          mx: -1,
          px: 1,
          py: 0.5,
          borderRadius: 1,
          transition: `background-color ${duration.fast * 1000}ms ${cssEase(easeOutQuint)}`,
          "&:hover": { bgcolor: "action.hover" },
          "@media (prefers-reduced-motion: reduce)": {
            transition: "none",
          },
        }}
      >
        <TranscriptionRowHeader
          createdAt={transcription?.createdAt}
          isRemoteTranscript={isRemoteTranscript}
          isSentToRemote={isSentToRemote}
          hasMetadata={hasMetadata}
          activeRemoteTarget={activeRemoteTarget}
          onDetailsOpen={handleDetailsOpen}
          onCopy={() => handleCopyText(transcription?.transcript || "")}
          onDelete={() => handleDeleteTranscript(id)}
          onSend={handleSendToReceiver}
        />
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
                <RetranscribeAction
                  id={id}
                  isRetranscribing={isRetranscribing}
                  didRetranscribe={didRetranscribe}
                  prefersReducedMotion={prefersReducedMotion}
                />
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
      </Box>
      <Divider sx={{ mt: 2 }} />
      {ctxMenu.renderMenu()}
    </Box>
  );
};
