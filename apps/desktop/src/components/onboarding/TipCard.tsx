import { CloseRounded } from "@mui/icons-material";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { dismissTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import type { OnboardingTipId } from "../../utils/tips";

export const TIP_COPY: Record<
  OnboardingTipId,
  { title: ReactNode; body: ReactNode; action: ReactNode }
> = {
  "generative-provider": {
    title: (
      <FormattedMessage defaultMessage="Add an AI provider for polishing" />
    ),
    body: (
      <FormattedMessage defaultMessage="Dictation works on its own, but styles and cleanup need a text-generation provider. Add one to unlock polishing, rewrites, and the assistant." />
    ),
    action: <FormattedMessage defaultMessage="Open settings" />,
  },
  "writing-styles": {
    title: <FormattedMessage defaultMessage="Teach mausVoice how you write" />,
    body: (
      <FormattedMessage defaultMessage="Styles reshape your dictation into your voice: emails, notes, code comments. Create one from a sample and it applies on every insert." />
    ),
    action: <FormattedMessage defaultMessage="Browse styles" />,
  },
  "assistant-mode": {
    title: <FormattedMessage defaultMessage="Talk to the assistant" />,
    body: (
      <FormattedMessage defaultMessage="Beyond dictation, the assistant answers questions, edits text, and runs tools in this chat. Anything you dictate can become a question." />
    ),
    action: <FormattedMessage defaultMessage="Open chat" />,
  },
  "review-before-insert": {
    title: <FormattedMessage defaultMessage="Review before it inserts" />,
    body: (
      <FormattedMessage defaultMessage="Review mode holds each transcript on the pill first, so you can edit or cancel before a word reaches your document." />
    ),
    action: <FormattedMessage defaultMessage="See history" />,
  },
  "update-channel": {
    title: <FormattedMessage defaultMessage="Try beta builds early" />,
    body: (
      <FormattedMessage defaultMessage="Stable ships tested releases. The beta channel offers prereleases early, and you can switch back at any time from settings." />
    ),
    action: <FormattedMessage defaultMessage="Open settings" />,
  },
};

export const useTip = (id: OnboardingTipId): boolean =>
  useAppStore((s) => !(s.local.dismissedTipIds ?? []).includes(id));

export const TipCard = ({
  id,
  href,
}: {
  id: OnboardingTipId;
  href?: string;
}) => {
  const intl = useIntl();
  const navigate = useNavigate();
  const visible = useTip(id);
  if (!visible) return null;
  const copy = TIP_COPY[id];

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: 2,
        border: 1,
        borderColor: "divider",
        bgcolor: "level1",
      }}
    >
      <Stack spacing={1}>
        <Stack
          direction="row"
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="subtitle2">{copy.title}</Typography>
          <IconButton
            size="small"
            onClick={() => dismissTip(id)}
            aria-label={intl.formatMessage({ defaultMessage: "Dismiss tip" })}
          >
            <CloseRounded fontSize="small" />
          </IconButton>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {copy.body}
        </Typography>
        {href && (
          <Box>
            <Button
              size="small"
              variant="outlined"
              onClick={() => navigate(href)}
            >
              {copy.action}
            </Button>
          </Box>
        )}
      </Stack>
    </Box>
  );
};
