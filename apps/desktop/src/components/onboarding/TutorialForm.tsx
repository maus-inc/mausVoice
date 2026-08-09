import { ArrowForward, Check, Email, TouchApp } from "@mui/icons-material";
import {
  Box,
  Button,
  keyframes,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { motion } from "framer-motion";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showConfetti, showErrorSnackbar } from "../../actions/app.actions";
import { clearLocalStorageValue } from "../../actions/local-storage.actions";
import {
  finishOnboarding,
  submitOnboarding,
} from "../../actions/onboarding.actions";
import { setSelectedToneId } from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  DICTATE_HOTKEY,
  getHotkeyCombosForAction,
} from "../../utils/keyboard.utils";
import { POLISHED_TONE_ID, EMAIL_TONE_ID } from "../../utils/tone.utils";
import { getMyUser } from "../../utils/user.utils";
import { DictationInstruction } from "../common/DictationInstruction";
import { HotkeyBadge } from "../common/HotkeyBadge";
import { BouncyTooltip } from "./BouncyTooltip";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

// The surrounding card deliberately mimics a third-party notes app, so its
// greys stay literal; only the focus accent follows the mausVoice brand blue.
const pulseNotes = keyframes`
  0%, 100% {
    border-color: color-mix(in srgb, var(--app-palette-blue) 40%, transparent);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--app-palette-blue) 40%, transparent);
  }
  50% {
    border-color: var(--app-palette-blue);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-palette-blue) 30%, transparent);
  }
`;

const pulseEmail = keyframes`
  0%, 100% {
    border-color: rgba(26, 115, 232, 0.4);
    box-shadow: 0 0 0 0 rgba(26, 115, 232, 0.4);
  }
  50% {
    border-color: rgba(26, 115, 232, 1);
    box-shadow: 0 0 0 4px rgba(26, 115, 232, 0.3);
  }
`;

const PAGE_COUNT = 2;

export const TutorialForm = () => {
  const intl = useIntl();
  const [stepIndex, setStepIndex] = useState(0);
  const [dictationValue, setDictationValue] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isFieldFocused, setIsFieldFocused] = useState(false);
  const [hasStartedDictating, setHasStartedDictating] = useState(false);
  const userExists = useAppStore((state) => Boolean(getMyUser(state)));
  const submittedRef = useRef(false);
  const submissionCompleteRef = useRef(false);

  const hotkeyCombos = useAppStore((state) =>
    getHotkeyCombosForAction(state, DICTATE_HOTKEY),
  );
  const primaryHotkey = hotkeyCombos[0] ?? [];
  const keysHeld = useAppStore((state) => state.keysHeld);
  const userName = useAppStore((state) => state.onboarding.name) || "Alex";

  useEffect(() => {
    if (primaryHotkey.length === 0) return;
    const hotkeySet = new Set(primaryHotkey);
    const allHotkeyKeysHeld = primaryHotkey.every((key) =>
      keysHeld.includes(key),
    );
    if (
      allHotkeyKeysHeld &&
      keysHeld.length >= hotkeySet.size &&
      isFieldFocused
    ) {
      setHasStartedDictating(true);
    }
  }, [keysHeld, primaryHotkey]);

  const setChatTone = async (toneId: string, force = false): Promise<void> => {
    if (!userExists && !force) {
      return;
    }

    await setSelectedToneId(toneId);
  };

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        if (!submittedRef.current) {
          submittedRef.current = true;
          await submitOnboarding();
          submissionCompleteRef.current = true;
        }

        if (cancelled) {
          return;
        }

        produceAppState((draft) => {
          draft.onboarding.dictationOverrideEnabled = true;
        });
      } finally {
        if (!cancelled) {
          setInitializing(false);
        }
      }
    };

    init();
    return () => {
      cancelled = true;
      setChatTone(POLISHED_TONE_ID, submissionCompleteRef.current).then(() => {
        clearLocalStorageValue("mausvoice:checklist-writing-style");
      });
      produceAppState((draft) => {
        draft.onboarding.dictationOverrideEnabled = false;
      });
    };
  }, []);

  const isLastStep = stepIndex === PAGE_COUNT - 1;
  const canContinue = dictationValue.trim().length > 0;

  const handleDictationChange = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setDictationValue(event.target.value);
  };

  const handleContinue = async () => {
    if (!isLastStep) {
      trackButtonClick("onboarding_tutorial_continue");
      setStepIndex(stepIndex + 1);
      setDictationValue("");
    } else {
      trackButtonClick("onboarding_tutorial_finish");
      await handleFinish();
    }
  };

  const handleSkip = async () => {
    trackButtonClick("onboarding_tutorial_skip");
    await handleFinish();
  };

  const handleFinish = async () => {
    setSubmitting(true);
    try {
      await finishOnboarding();
      showConfetti();
    } catch (err) {
      showErrorSnackbar(err);
      setSubmitting(false);
    }
  };

  const step1Placeholder = intl.formatMessage({
    defaultMessage: "Bagels are the breakfast of champions.",
  });

  const step2Placeholder = `Hey Bob,

Great meeting you yesterday! Looking forward to next steps.

Best,
${userName}`;

  useEffect(() => {
    if (!userExists) {
      return;
    }

    if (stepIndex === 0) {
      // Notes step
      setChatTone(POLISHED_TONE_ID);
    } else if (stepIndex === 1) {
      // Email step
      setChatTone(EMAIL_TONE_ID);
    }
  }, [stepIndex, userExists]);

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <Stack direction="row" spacing={2}>
          <Button
            variant="text"
            onClick={() => void handleSkip()}
            disabled={submitting}
          >
            <FormattedMessage defaultMessage="Skip" />
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleContinue()}
            disabled={!canContinue || submitting}
            endIcon={isLastStep ? <Check /> : <ArrowForward />}
          >
            {isLastStep ? (
              <FormattedMessage defaultMessage="Finish" />
            ) : (
              <FormattedMessage defaultMessage="Continue" />
            )}
          </Button>
        </Stack>
      }
    >
      {stepIndex === 0 && (
        <Stack spacing={2} pb={8}>
          <Typography variant="h4" fontWeight={600}>
            <FormattedMessage defaultMessage="Try out dictation" />
          </Typography>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage defaultMessage="Press and hold your hotkey, then start talking. When you release the key, your speech will be converted to text." />
          </Typography>
          <DictationInstruction />
        </Stack>
      )}
      {stepIndex === 1 && (
        <Stack spacing={2} pb={8}>
          <Typography variant="h4" fontWeight={600}>
            <FormattedMessage defaultMessage="Now try an email" />
          </Typography>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage defaultMessage="Dictate a short email. mausVoice works great for longer-form content like messages, notes, and documents." />
          </Typography>
          <DictationInstruction />
        </Stack>
      )}
    </OnboardingFormLayout>
  );

  const bouncyTooltips = (
    <>
      <BouncyTooltip
        visible={!isFieldFocused && !hasStartedDictating}
        delay={0.7}
      >
        <TouchApp fontSize="small" />
        <Typography variant="body2" fontWeight={500}>
          <FormattedMessage defaultMessage="Click on the text field" />
        </Typography>
      </BouncyTooltip>
      <BouncyTooltip
        visible={isFieldFocused && !hasStartedDictating}
        delay={0.7}
      >
        <Typography variant="body2" fontWeight={500}>
          <FormattedMessage defaultMessage="Now press and hold" />
        </Typography>
        <HotkeyBadge
          keys={primaryHotkey}
          sx={{
            bgcolor: "rgba(255,255,255,0.2)",
            borderColor: "rgba(255,255,255,0.3)",
            color: "primary.contrastText",
          }}
        />
        <Typography variant="body2" fontWeight={500}>
          <FormattedMessage defaultMessage="to dictate" />
        </Typography>
      </BouncyTooltip>
    </>
  );

  const notesContent = (
    <Box sx={{ position: "relative", pb: 6 }}>
      <Stack
        spacing={0}
        sx={{
          bgcolor: "#ffffff",
          borderRadius: 1.33,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.15)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1.5,
            borderBottom: "1px solid #e0e0e0",
            bgcolor: "#f5f5f5",
          }}
        >
          <Typography
            variant="body2"
            fontWeight={600}
            sx={{ color: "#202124" }}
          >
            Notes
          </Typography>
        </Box>
        <Box sx={{ p: 2 }}>
          <TextField
            multiline
            minRows={4}
            fullWidth
            placeholder={step1Placeholder}
            value={dictationValue}
            onChange={handleDictationChange}
            disabled={submitting}
            onFocus={() => setIsFieldFocused(true)}
            onBlur={() => setIsFieldFocused(false)}
            sx={{
              "& .MuiOutlinedInput-root": {
                bgcolor: "#ffffff",
                borderRadius: 1,
                "& fieldset": isFieldFocused
                  ? { borderColor: "#e0e0e0" }
                  : {
                      borderWidth: 2,
                      animation: `${pulseNotes} 1.5s ease-in-out infinite`,
                    },
                "&:hover fieldset": {
                  borderColor: isFieldFocused ? "#e0e0e0" : undefined,
                },
                "&.Mui-focused fieldset": {
                  borderColor: "var(--app-palette-blue)",
                },
              },
              "& .MuiInputBase-input": {
                color: "#202124",
                "&::placeholder": {
                  color: "#5f6368",
                  opacity: 1,
                },
              },
            }}
          />
        </Box>
      </Stack>
      {bouncyTooltips}
    </Box>
  );

  const emailContent = (
    <Box sx={{ position: "relative", pb: 6 }}>
      <Stack
        spacing={0}
        sx={{
          bgcolor: "#ffffff",
          borderRadius: 1.33,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.15)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1.5,
            borderBottom: "1px solid #e0e0e0",
            bgcolor: "#f5f5f5",
          }}
        >
          <Email sx={{ fontSize: 20, color: "#d93025" }} />
          <Typography
            variant="body2"
            fontWeight={600}
            sx={{ color: "#202124" }}
          >
            Email
          </Typography>
        </Box>
        <Box sx={{ p: 2 }}>
          <Box sx={{ mb: 2 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                mb: 1,
                pb: 1,
                borderBottom: "1px solid #e0e0e0",
              }}
            >
              <Typography variant="caption" sx={{ color: "#5f6368" }}>
                To:
              </Typography>
              <Typography variant="body2" sx={{ color: "#202124" }}>
                sarah@company.com
              </Typography>
            </Box>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                pb: 1,
                borderBottom: "1px solid #e0e0e0",
              }}
            >
              <Typography variant="caption" sx={{ color: "#5f6368" }}>
                Subject:
              </Typography>
              <Typography variant="body2" sx={{ color: "#202124" }}>
                Great chatting yesterday! 🎉
              </Typography>
            </Box>
          </Box>
          <Box sx={{ position: "relative" }}>
            <TextField
              multiline
              minRows={8}
              fullWidth
              autoFocus={true}
              value={dictationValue}
              onChange={handleDictationChange}
              disabled={submitting}
              onFocus={() => setIsFieldFocused(true)}
              onBlur={() => setIsFieldFocused(false)}
              sx={{
                "& .MuiOutlinedInput-root": {
                  bgcolor: "#ffffff",
                  borderRadius: 1,
                  "& fieldset": isFieldFocused
                    ? { borderColor: "#e0e0e0" }
                    : {
                        borderWidth: 2,
                        animation: `${pulseEmail} 1.5s ease-in-out infinite`,
                      },
                  "&:hover fieldset": {
                    borderColor: isFieldFocused ? "#e0e0e0" : undefined,
                  },
                  "&.Mui-focused fieldset": {
                    borderColor: "#1a73e8",
                  },
                },
                "& .MuiInputBase-input": {
                  color: "#202124",
                },
              }}
            />
            {dictationValue.length === 0 && (
              <Typography
                variant="body1"
                sx={{
                  position: "absolute",
                  top: 16.5,
                  left: 14,
                  right: 14,
                  color: "#5f6368",
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                }}
              >
                {step2Placeholder}
              </Typography>
            )}
          </Box>
        </Box>
      </Stack>
      {bouncyTooltips}
    </Box>
  );

  const stepper = (
    <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
      {[0, 1].map((index) => (
        <Box
          key={index}
          onClick={() => {
            setStepIndex(index);
            setDictationValue("");
            setHasStartedDictating(false);
          }}
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: stepIndex === index ? "primary.main" : "action.disabled",
            transition: "background-color 0.2s ease",
            cursor: "pointer",
            "&:hover": {
              bgcolor: stepIndex === index ? "primary.main" : "action.hover",
            },
          }}
        />
      ))}
    </Stack>
  );

  const rightContent = (
    <Stack sx={{ width: "100%", maxWidth: 400, alignItems: "stretch" }}>
      {!initializing && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {stepIndex === 0 ? notesContent : emailContent}
          {stepper}
        </motion.div>
      )}
    </Stack>
  );

  return (
    <DualPaneLayout
      flex={[2, 3]}
      left={form}
      right={rightContent}
      rightSx={{ bgcolor: "transparent" }}
    />
  );
};
