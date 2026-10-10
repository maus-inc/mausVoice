import { ContentCopyRounded, DoNotDisturbRounded } from "@mui/icons-material";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import type { ChatMessage } from "@maus-inc/types";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  cancelPendingPasteReview,
  copyPendingPasteReview,
  getPendingPasteReview,
} from "../../actions/pending-paste-review.actions";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { getIntl } from "../../i18n/intl";

type PendingPasteReviewBubbleProps = {
  message: ChatMessage;
};

export const PendingPasteReviewBubble = ({
  message,
}: PendingPasteReviewBubbleProps) => {
  const pending = getPendingPasteReview(message.metadata);
  const [text, setText] = useState(pending?.text ?? "");
  const [busy, setBusy] = useState(false);
  const outcomeNode = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    setText(pending?.text ?? "");
  }, [pending?.text]);

  // Focus the outcome the moment the pending instructions are replaced by it,
  // so focus lands on the result instead of on the row whose buttons just
  // unmounted. An inline `ref={node => node?.focus()}` cannot do this: it is a
  // new function identity on every render, so React re-invokes it on every
  // render and the card steals focus back from whatever the user moved on to.
  const status = pending?.status;
  useEffect(() => {
    if (status && status !== "pending") outcomeNode.current?.focus();
  }, [status]);

  if (!pending) return null;

  const resolvedLabel =
    pending.status === "copied" ? (
      <FormattedMessage defaultMessage="Copied for manual paste" />
    ) : (
      <FormattedMessage defaultMessage="Cancelled" />
    );

  const copyForManualPaste = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await copyPendingPasteReview(message, text);
      showSnackbar(
        getIntl().formatMessage({
          defaultMessage:
            "Copied. Focus the destination app and paste it there.",
        }),
        { mode: "success" },
      );
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await cancelPendingPasteReview(message, text);
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        maxWidth: "75%",
        px: 1.5,
        py: 1.25,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "action.hover",
      }}
    >
      <Stack spacing={1}>
        <Box>
          <Typography variant="subtitle2">
            <FormattedMessage defaultMessage="Paste action waiting for you" />
          </Typography>
          {/* The body swaps between the pending instructions and the resolved
              outcome, and both the Copy and Cancel buttons unmount at that
              point. Without a live region the replacement is silent: a screen
              reader user hears nothing, and focus is left on a removed node.
              `role="status"` announces the change, and the focus effect above
              lands on the outcome rather than dropping it. */}
          <Typography
            variant="body2"
            color="text.secondary"
            role="status"
            aria-live="polite"
            tabIndex={pending.status === "pending" ? undefined : 0}
            ref={outcomeNode}
          >
            {pending.status === "pending" ? (
              <FormattedMessage defaultMessage="Opening Chats changes the focused app. Copy this text, then focus the destination and paste it there." />
            ) : (
              resolvedLabel
            )}
          </Typography>
        </Box>
        <TextField
          aria-label={getIntl().formatMessage({
            defaultMessage: "Text prepared for manual paste",
          })}
          multiline
          minRows={3}
          value={text}
          disabled={busy || pending.status !== "pending"}
          onChange={(event) => setText(event.target.value)}
          fullWidth
          size="small"
        />
        {pending.status === "pending" && (
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              startIcon={<ContentCopyRounded />}
              disabled={busy || !text.trim()}
              onClick={copyForManualPaste}
            >
              <FormattedMessage defaultMessage="Copy for manual paste" />
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<DoNotDisturbRounded />}
              disabled={busy}
              onClick={cancel}
            >
              <FormattedMessage defaultMessage="Cancel" />
            </Button>
          </Stack>
        )}
      </Stack>
    </Box>
  );
};
