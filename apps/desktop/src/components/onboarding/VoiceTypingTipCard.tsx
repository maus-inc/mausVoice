import { Mic, X } from "lucide-react";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  acceptVoiceTypingTip,
  declineVoiceTypingTipWithNoThanks,
  dismissVoiceTypingTip,
  formatVoiceTypingTipBody,
} from "../../actions/voice-typing-tip.actions";
import { useAppStore } from "../../store";
import { duration } from "../../styles/motion";
import { hairline, premiumSurface } from "../../styles/shadows";
import { classifyWebviewActiveElement } from "../../utils/voice-typing-tip";
import { tipActionButtonSx } from "./TipCard";

/**
 * Quiet, headerless floating nudge shown after sustained prose typing.
 *
 * Uses `data-voice-typing-tip="true"` (never `data-tip-card` or `data-tip-frame`,
 * which identify static onboarding tips) and never steals keyboard focus when
 * mounting or revealing the delayed "No thanks" action.
 */
export const VoiceTypingTipCard = () => {
  const intl = useIntl();
  const reduced = useReducedMotion();
  const prompt = useAppStore((state) => state.voiceTypingTipPrompt);
  const previouslyFocusedEditableRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!prompt || typeof document === "undefined") {
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      classifyWebviewActiveElement(active) === "eligible"
    ) {
      previouslyFocusedEditableRef.current = active;
    }
  }, [prompt]);

  const restoreFocusToEditor = () => {
    const target = previouslyFocusedEditableRef.current;
    if (target && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  };

  const handleClose = () => {
    dismissVoiceTypingTip();
    restoreFocusToEditor();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    handleClose();
  };

  const body = prompt ? formatVoiceTypingTipBody(prompt, intl) : "";
  const enterTransition = reduced
    ? { duration: 0 }
    : { duration: 0.16, ease: "easeOut" as const };
  const exitTransition = reduced
    ? { duration: 0 }
    : { duration: duration.exit, ease: "easeOut" as const };

  return (
    <AnimatePresence>
      {prompt && (
        <Box
          key={prompt.id}
          component={motion.div}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0, transition: enterTransition }}
          exit={
            reduced
              ? { opacity: 0, transition: exitTransition }
              : { opacity: 0, y: -6, transition: exitTransition }
          }
          data-voice-typing-tip="true"
          role="region"
          aria-label={intl.formatMessage({
            defaultMessage: "Voice typing tip",
          })}
          onKeyDown={handleKeyDown}
          sx={(cardTheme) => ({
            width: 340,
            maxWidth: "calc(100vw - 32px)",
            borderRadius: `${cardTheme.shape.borderRadius}px`,
            px: 2,
            py: 1.75,
            border: hairline.light(),
            boxShadow: premiumSurface.light.hover,
            bgcolor: "background.paper",
            ...cardTheme.applyStyles("dark", {
              border: hairline.dark(),
              boxShadow: premiumSurface.dark.hover,
            }),
          })}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ alignItems: "flex-start" }}
          >
            <Box
              component="span"
              aria-hidden
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                mt: 0.125,
                flexShrink: 0,
                color: "text.secondary",
              }}
            >
              <Mic size={16} strokeWidth={1.9} aria-hidden />
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{
                  color: "text.primary",
                  textWrap: "pretty",
                  pr: 0.5,
                }}
              >
                {body}
              </Typography>

              <Stack
                direction="row"
                useFlexGap
                spacing={1}
                sx={{
                  flexWrap: "wrap",
                  alignItems: "center",
                  mt: 1.25,
                }}
              >
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  sx={tipActionButtonSx}
                  onClick={() => acceptVoiceTypingTip()}
                >
                  {prompt.ctaKind === "try" ? (
                    <FormattedMessage defaultMessage="Try voice typing" />
                  ) : (
                    <FormattedMessage defaultMessage="Set up voice typing" />
                  )}
                </Button>

                <AnimatePresence initial={false}>
                  {prompt.noThanksVisible && (
                    <Box
                      key="no-thanks"
                      component={motion.span}
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity: 1,
                        transition: reduced
                          ? { duration: 0 }
                          : { duration: duration.fast, ease: "easeOut" },
                      }}
                      exit={{ opacity: 0, transition: { duration: 0 } }}
                      sx={{ display: "inline-flex" }}
                    >
                      <Button
                        size="small"
                        variant="text"
                        color="inherit"
                        data-voice-typing-tip-no-thanks="true"
                        sx={(theme) => ({
                          ...tipActionButtonSx(theme),
                          color: "text.secondary",
                          "&:hover": {
                            color: "text.primary",
                            bgcolor: "action.hover",
                          },
                        })}
                        onClick={() => {
                          declineVoiceTypingTipWithNoThanks();
                          restoreFocusToEditor();
                        }}
                      >
                        <FormattedMessage defaultMessage="No thanks" />
                      </Button>
                    </Box>
                  )}
                </AnimatePresence>
              </Stack>
            </Box>

            <IconButton
              size="small"
              onClick={handleClose}
              aria-label={intl.formatMessage({
                defaultMessage: "Dismiss voice typing tip",
              })}
              sx={{
                mt: -0.375,
                mr: -0.5,
                width: 28,
                height: 28,
                color: "text.secondary",
                "&:hover": {
                  color: "text.primary",
                  bgcolor: "action.hover",
                },
              }}
            >
              <X size={15} strokeWidth={1.9} aria-hidden />
            </IconButton>
          </Stack>
        </Box>
      )}
    </AnimatePresence>
  );
};
