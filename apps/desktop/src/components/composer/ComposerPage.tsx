import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Mic } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { countWords } from "../../utils/string.utils";
import { MetalChrome } from "../common/MetalChrome";
import {
  useComposerFinish,
  useComposerPeekText,
  useVoiceEdit,
  useVoiceEditAvailability,
  useVoiceInstructionRecorder,
  useVoiceRecorderMessages,
} from "./useComposerVoiceEdit";

/**
 * The composer window's scroll owner. The app viewport clips, and the document
 * never scrolls, so this shell is what keeps a long transcript reachable at
 * the minimum window height. The card centres with `margin: auto`: centring
 * with the flex container would hide the top of a card taller than the window
 * behind an unreachable scroll range.
 */
const ComposerShell = ({ children }: { children: React.ReactNode }) => (
  <Box
    sx={{
      height: "100%",
      overflowY: "auto",
      bgcolor: "background.default",
      p: { xs: 2, sm: 3 },
      display: "flex",
    }}
  >
    <Paper
      elevation={8}
      sx={{
        width: "100%",
        maxWidth: 640,
        m: "auto",
        borderRadius: 3,
        p: { xs: 2, sm: 3 },
      }}
    >
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  </Box>
);

const ComposerHeader = () => (
  <Box>
    <Typography variant="h6" sx={{ fontWeight: 700 }}>
      <FormattedMessage defaultMessage="Review transcript" />
    </Typography>
    <Typography variant="body2" color="text.secondary">
      <FormattedMessage defaultMessage="Edit the text before inserting it." />
    </Typography>
  </Box>
);

const ComposerTranscriptSection = ({
  intl,
  transcriptRef,
  text,
  onTextChange,
  editError,
  sessionOriginal,
  undoText,
  isEditing,
  onUndo,
}: {
  intl: ReturnType<typeof useIntl>;
  transcriptRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (next: string) => void;
  editError: string | null;
  sessionOriginal: string;
  undoText: string | null;
  isEditing: boolean;
  onUndo: () => void;
}) => (
  <>
    <TextField
      inputRef={transcriptRef}
      multiline
      minRows={7}
      fullWidth
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      aria-label={intl.formatMessage({ defaultMessage: "Transcript" })}
    />
    {editError && (
      <Typography variant="caption" color="error">
        {editError}
      </Typography>
    )}
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="caption" color="text.secondary">
        <FormattedMessage
          defaultMessage="{count, plural, one {# word} other {# words}}"
          values={{ count: countWords(text) }}
        />
        {sessionOriginal !== "" && text !== sessionOriginal ? (
          <>
            {" · "}
            <FormattedMessage defaultMessage="Unsaved Changes" />
          </>
        ) : null}
      </Typography>
      {undoText !== null && (
        <Button
          size="small"
          variant="text"
          disabled={isEditing}
          onClick={onUndo}
        >
          <FormattedMessage defaultMessage="Undo edit" />
        </Button>
      )}
    </Stack>
    {sessionOriginal !== "" && (
      <Accordion disableGutters>
        <AccordionSummary>
          <Typography variant="subtitle2">
            <FormattedMessage
              defaultMessage="Original transcript ({count, plural, one {# word} other {# words}})"
              values={{ count: countWords(sessionOriginal) }}
            />
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "pre-wrap" }}
          >
            {sessionOriginal}
          </Typography>
        </AccordionDetails>
      </Accordion>
    )}
  </>
);

const ComposerVoiceEditSection = ({
  intl,
  disabledReasonId,
  instruction,
  onInstructionChange,
  onApply,
  isListening,
  onToggleVoice,
  isEditing,
  hasGenerationProvider,
  voiceInstructionSupported,
  disabledReason,
}: {
  intl: ReturnType<typeof useIntl>;
  disabledReasonId: string;
  instruction: string;
  onInstructionChange: (next: string) => void;
  onApply: () => Promise<void>;
  isListening: boolean;
  onToggleVoice: () => void;
  isEditing: boolean;
  hasGenerationProvider: boolean;
  voiceInstructionSupported: boolean;
  disabledReason: string | null;
}) => (
  <>
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
      <TextField
        fullWidth
        size="small"
        label={<FormattedMessage defaultMessage="Voice Edit Mode" />}
        placeholder={intl.formatMessage({
          defaultMessage: "Make this shorter or turn it into bullets",
        })}
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void onApply();
          }
        }}
      />
      <IconButton
        color={isListening ? "error" : "primary"}
        onClick={onToggleVoice}
        aria-label={intl.formatMessage({
          defaultMessage: "Dictate edit instruction",
        })}
        disabled={isEditing || !voiceInstructionSupported}
        title={disabledReason ?? undefined}
        aria-describedby={disabledReason ? disabledReasonId : undefined}
      >
        <Mic size={20} strokeWidth={2} />
      </IconButton>
      <Button
        variant="outlined"
        onClick={() => void onApply()}
        disabled={!instruction.trim() || isEditing || !hasGenerationProvider}
        sx={{ whiteSpace: "nowrap", minHeight: 40 }}
      >
        {isEditing ? (
          <CircularProgress size={18} />
        ) : (
          <FormattedMessage defaultMessage="Apply" />
        )}
      </Button>
    </Stack>
    {disabledReason && (
      <Typography
        id={disabledReasonId}
        variant="caption"
        color="text.secondary"
      >
        {disabledReason}
      </Typography>
    )}
  </>
);

const ComposerActions = ({
  isEditing,
  text,
  onCancel,
  onInsert,
}: {
  isEditing: boolean;
  text: string;
  onCancel: () => void;
  onInsert: () => void;
}) => (
  <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
    <Button variant="text" onClick={onCancel}>
      <FormattedMessage defaultMessage="Cancel" />
    </Button>
    <MetalChrome>
      <Button
        variant="contained"
        onClick={onInsert}
        disabled={isEditing || !text.trim()}
      >
        <FormattedMessage defaultMessage="Insert" />
      </Button>
    </MetalChrome>
  </Stack>
);

export const ComposerPage = () => {
  const intl = useIntl();
  const disabledReasonId = useId();
  // Focus the transcript field explicitly once it has mounted rather than with
  // a DOM `autoFocus` prop: `autoFocus` fires as an attribute and cannot be
  // deferred, so it races anything that moves focus in the same commit. This
  // mirrors ContextMenu's own "focus after commit, not via autoFocus" rule.
  // `TextField` forwards `inputRef` to the underlying `<textarea>` (it passes
  // it straight to `Input`'s `inputRef`), so this reaches the real element.
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestId = params.get("requestId") ?? "";
  // Session original for the original-vs-edited view. Falls back to the
  // loaded text when the host opened the composer without one.
  const sessionOriginal = params.get("original") ?? "";

  // Tracks mount state so async edit work cannot setState after the composer
  // window is torn down (Esc / Cancel / unmount during a network round-trip).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const {
    speechRecognitionSupported,
    hasGenerationProvider,
    voiceInstructionSupported,
    disabledReason,
  } = useVoiceEditAvailability(intl);

  const { intlRef } = useVoiceRecorderMessages(intl);

  useEffect(() => {
    transcriptRef.current?.focus();
  }, []);

  const {
    text,
    setText,
    undoText,
    instruction,
    setInstruction,
    isEditing,
    editError,
    setEditError,
    isListening,
    setIsListening,
    recorderRef,
    applyEdit,
    toggleVoiceInstruction,
    handleTextChange,
    handleUndo,
    userEditedRef,
  } = useVoiceEdit({ intl, mountedRef });

  useVoiceInstructionRecorder({
    speechRecognitionSupported,
    intlRef,
    recorderRef,
    onListeningChange: setIsListening,
    onTranscript: (spoken) =>
      setInstruction((current) => `${current} ${spoken}`.trim()),
    onError: setEditError,
  });

  useComposerPeekText({
    intl,
    requestId,
    setText,
    setEditError,
    userEditedRef,
  });

  const { cancel, insert } = useComposerFinish({
    intl,
    requestId,
    text,
    recorderRef,
    setEditError,
    mountedRef,
  });

  return (
    <ComposerShell>
      <ComposerHeader />
      <ComposerTranscriptSection
        intl={intl}
        transcriptRef={transcriptRef}
        text={text}
        onTextChange={handleTextChange}
        editError={editError}
        sessionOriginal={sessionOriginal}
        undoText={undoText}
        isEditing={isEditing}
        onUndo={handleUndo}
      />
      <ComposerVoiceEditSection
        intl={intl}
        disabledReasonId={disabledReasonId}
        instruction={instruction}
        onInstructionChange={setInstruction}
        onApply={applyEdit}
        isListening={isListening}
        onToggleVoice={toggleVoiceInstruction}
        isEditing={isEditing}
        hasGenerationProvider={hasGenerationProvider}
        voiceInstructionSupported={voiceInstructionSupported}
        disabledReason={disabledReason}
      />
      <ComposerActions
        isEditing={isEditing}
        text={text}
        onCancel={cancel}
        onInsert={insert}
      />
    </ComposerShell>
  );
};
