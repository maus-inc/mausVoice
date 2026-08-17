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

/**
 * The notes/email demo card mimics a third-party app window: white card with a
 * grey header strip. `overlay` is rendered inside the relative container so
 * absolutely-positioned tooltips keep anchoring to the card.
 */
const TutorialWindow = ({
  header,
  children,
  overlay,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  overlay?: React.ReactNode;
}) => {
  return (
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
          {header}
        </Box>
        <Box sx={{ p: 2 }}>{children}</Box>
      </Stack>
      {overlay}
    </Box>
  );
};

const TutorialStepIntro = ({
  title,
  description,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
}) => {
  return (
    <Stack
      spacing={2}
      sx={{
        pb: 8,
      }}
    >
      <Typography
        variant="h4"
        sx={{
          fontWeight: 600,
        }}
      >
        {title}
      </Typography>
      <Typography
        variant="body1"
        sx={{
          color: "text.secondary",
        }}
      >
        {description}
      </Typography>
      <DictationInstruction />
    </Stack>
  );
};

const TutorialActionButtons = ({
  isLastStep,
  canContinue,
  submitting,
  onSkip,
  onContinue,
}: {
  isLastStep: boolean;
  canContinue: boolean;
  submitting: boolean;
  onSkip: () => void;
  onContinue: () => void;
}) => {
  return (
    <Stack direction="row" spacing={2}>
      <Button variant="text" onClick={onSkip} disabled={submitting}>
        <FormattedMessage defaultMessage="Skip" />
      </Button>
      <Button
        variant="contained"
        onClick={onContinue}
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
  );
};

const TutorialTooltips = ({
  isFieldFocused,
  hasStartedDictating,
  primaryHotkey,
}: {
  isFieldFocused: boolean;
  hasStartedDictating: boolean;
  primaryHotkey: string[];
}) => {
  return (
    <>
      <BouncyTooltip
        visible={!isFieldFocused && !hasStartedDictating}
        delay={0.7}
      >
        <TouchApp fontSize="small" />
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          <FormattedMessage defaultMessage="Click on the text field" />
        </Typography>
      </BouncyTooltip>
      <BouncyTooltip
        visible={isFieldFocused && !hasStartedDictating}
        delay={0.7}
      >
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
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
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
          }}
        >
          <FormattedMessage defaultMessage="to dictate" />
        </Typography>
      </BouncyTooltip>
    </>
  );
};

type TutorialFieldProps = {
  value: string;
  submitting: boolean;
  isFieldFocused: boolean;
  placeholder: string;
  overlay: React.ReactNode;
  onChange: (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  onFocus: () => void;
  onBlur: () => void;
};

type TutorialFieldSxArgs = {
  isFieldFocused: boolean;
  pulse: string;
  focusBorderColor: string;
  placeholderColor?: string;
};

// Shared demo-window field styling: white card, pulse animation until focused,
// brand focus color, and (for the notes field) a muted placeholder.
const tutorialFieldSx = ({
  isFieldFocused,
  pulse,
  focusBorderColor,
  placeholderColor,
}: TutorialFieldSxArgs) => ({
  "& .MuiOutlinedInput-root": {
    bgcolor: "#ffffff",
    borderRadius: 1,
    "& fieldset": isFieldFocused
      ? { borderColor: "#e0e0e0" }
      : {
          borderWidth: 2,
          animation: `${pulse} 1.5s ease-in-out infinite`,
        },
    "&:hover fieldset": {
      borderColor: isFieldFocused ? "#e0e0e0" : undefined,
    },
    "&.Mui-focused fieldset": {
      borderColor: focusBorderColor,
    },
  },
  "& .MuiInputBase-input": {
    color: "#202124",
    ...(placeholderColor
      ? {
          "&::placeholder": {
            color: placeholderColor,
            opacity: 1,
          },
        }
      : {}),
  },
});

const NotesStep = ({
  value,
  submitting,
  isFieldFocused,
  placeholder,
  overlay,
  onChange,
  onFocus,
  onBlur,
}: TutorialFieldProps) => {
  return (
    <TutorialWindow
      header={
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: "#202124",
          }}
        >
          Notes
        </Typography>
      }
      overlay={overlay}
    >
      <TextField
        multiline
        minRows={4}
        fullWidth
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={submitting}
        onFocus={onFocus}
        onBlur={onBlur}
        sx={tutorialFieldSx({
          isFieldFocused,
          pulse: pulseNotes,
          focusBorderColor: "var(--app-palette-blue)",
          placeholderColor: "#5f6368",
        })}
      />
    </TutorialWindow>
  );
};

const EmailStep = ({
  value,
  submitting,
  isFieldFocused,
  placeholder,
  overlay,
  onChange,
  onFocus,
  onBlur,
}: TutorialFieldProps) => {
  return (
    <TutorialWindow
      header={
        <>
          <Email sx={{ fontSize: 20, color: "#d93025" }} />
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              color: "#202124",
            }}
          >
            Email
          </Typography>
        </>
      }
      overlay={overlay}
    >
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
          autoFocus
          value={value}
          onChange={onChange}
          disabled={submitting}
          onFocus={onFocus}
          onBlur={onBlur}
          sx={tutorialFieldSx({
            isFieldFocused,
            pulse: pulseEmail,
            focusBorderColor: "#1a73e8",
          })}
        />
        {value.length === 0 && (
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
            {placeholder}
          </Typography>
        )}
      </Box>
    </TutorialWindow>
  );
};

const TutorialStepper = ({
  stepIndex,
  onSelect,
}: {
  stepIndex: number;
  onSelect: (index: number) => void;
}) => {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        justifyContent: "center",
        mt: 2,
      }}
    >
      {[0, 1].map((index) => (
        <Box
          key={index}
          onClick={() => onSelect(index)}
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
};

/**
 * Runs the onboarding submission once on mount and keeps the dictation
 * override enabled for the tutorial session, restoring it on unmount.
 */
const useTutorialSubmission = ({
  setChatTone,
}: {
  setChatTone: (toneId: string, force?: boolean) => Promise<void>;
}) => {
  const submittedRef = useRef(false);
  const submissionCompleteRef = useRef(false);
  const [initializing, setInitializing] = useState(true);
  const setChatToneRef = useRef(setChatTone);

  useEffect(() => {
    setChatToneRef.current = setChatTone;
  }, [setChatTone]);

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

    void init();
    return () => {
      cancelled = true;
      void setChatToneRef
        .current(POLISHED_TONE_ID, submissionCompleteRef.current)
        .catch((error) => {
          console.error("Failed to reset tutorial tone on unmount", error);
        })
        .finally(() => {
          clearLocalStorageValue("mausvoice:checklist-writing-style");
        });
      produceAppState((draft) => {
        draft.onboarding.dictationOverrideEnabled = false;
      });
    };
  }, []);

  return { initializing };
};

/** Marks the tutorial as "started" once the user holds the hotkey combo. */
const useTutorialDictationStart = ({
  primaryHotkey,
  keysHeld,
  isFieldFocused,
  onStarted,
}: {
  primaryHotkey: string[];
  keysHeld: string[];
  isFieldFocused: boolean;
  onStarted: () => void;
}) => {
  const onStartedRef = useRef(onStarted);

  useEffect(() => {
    onStartedRef.current = onStarted;
  }, [onStarted]);

  useEffect(() => {
    if (primaryHotkey.length === 0) {
      return;
    }
    const hotkeySet = new Set(primaryHotkey);
    const allHotkeyKeysHeld = primaryHotkey.every((key) =>
      keysHeld.includes(key),
    );
    if (
      allHotkeyKeysHeld &&
      keysHeld.length >= hotkeySet.size &&
      isFieldFocused
    ) {
      onStartedRef.current();
    }
  }, [keysHeld, primaryHotkey, isFieldFocused]);
};

/** Applies the writing style matching the current tutorial step. */
const useTutorialToneSync = ({
  stepIndex,
  userExists,
  setChatTone,
}: {
  stepIndex: number;
  userExists: boolean;
  setChatTone: (toneId: string, force?: boolean) => Promise<void>;
}) => {
  const setChatToneRef = useRef(setChatTone);

  useEffect(() => {
    setChatToneRef.current = setChatTone;
  }, [setChatTone]);

  useEffect(() => {
    if (!userExists) {
      return;
    }
    if (stepIndex === 0) {
      // Notes step
      void setChatToneRef.current(POLISHED_TONE_ID);
    } else if (stepIndex === 1) {
      // Email step
      void setChatToneRef.current(EMAIL_TONE_ID);
    }
  }, [stepIndex, userExists]);
};

export const TutorialForm = () => {
  const intl = useIntl();
  const [stepIndex, setStepIndex] = useState(0);
  const [dictationValue, setDictationValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isFieldFocused, setIsFieldFocused] = useState(false);
  const [hasStartedDictating, setHasStartedDictating] = useState(false);
  const userExists = useAppStore((state) => Boolean(getMyUser(state)));

  const hotkeyCombos = useAppStore((state) =>
    getHotkeyCombosForAction(state, DICTATE_HOTKEY),
  );
  const primaryHotkey = hotkeyCombos[0] ?? [];
  const keysHeld = useAppStore((state) => state.keysHeld);
  const userName = useAppStore((state) => state.onboarding.name) || "Alex";

  const setChatTone = async (toneId: string, force = false): Promise<void> => {
    if (!userExists && !force) {
      return;
    }

    await setSelectedToneId(toneId);
  };

  const { initializing } = useTutorialSubmission({ setChatTone });
  useTutorialDictationStart({
    primaryHotkey,
    keysHeld,
    isFieldFocused,
    onStarted: () => setHasStartedDictating(true),
  });
  useTutorialToneSync({ stepIndex, userExists, setChatTone });

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

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <TutorialActionButtons
          isLastStep={isLastStep}
          canContinue={canContinue}
          submitting={submitting}
          onSkip={() => void handleSkip()}
          onContinue={() => void handleContinue()}
        />
      }
    >
      {stepIndex === 0 && (
        <TutorialStepIntro
          title={<FormattedMessage defaultMessage="Try out dictation" />}
          description={
            <FormattedMessage defaultMessage="Press and hold your hotkey, then start talking. When you release the key, your speech will be converted to text." />
          }
        />
      )}
      {stepIndex === 1 && (
        <TutorialStepIntro
          title={<FormattedMessage defaultMessage="Now try an email" />}
          description={
            <FormattedMessage defaultMessage="Dictate a short email. mausVoice works great for longer-form content like messages, notes, and documents." />
          }
        />
      )}
    </OnboardingFormLayout>
  );

  const fieldProps: Omit<TutorialFieldProps, "overlay"> = {
    value: dictationValue,
    submitting,
    isFieldFocused,
    placeholder: stepIndex === 0 ? step1Placeholder : step2Placeholder,
    onChange: handleDictationChange,
    onFocus: () => setIsFieldFocused(true),
    onBlur: () => setIsFieldFocused(false),
  };

  const tooltips = (
    <TutorialTooltips
      isFieldFocused={isFieldFocused}
      hasStartedDictating={hasStartedDictating}
      primaryHotkey={primaryHotkey}
    />
  );

  const rightContent = (
    <Stack sx={{ width: "100%", maxWidth: 400, alignItems: "stretch" }}>
      {!initializing && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {stepIndex === 0 ? (
            <NotesStep {...fieldProps} overlay={tooltips} />
          ) : (
            <EmailStep {...fieldProps} overlay={tooltips} />
          )}
          <TutorialStepper
            stepIndex={stepIndex}
            onSelect={(index) => {
              setStepIndex(index);
              setDictationValue("");
              setHasStartedDictating(false);
            }}
          />
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
