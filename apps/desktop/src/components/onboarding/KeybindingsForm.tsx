import { useHotkeyCapture } from "../../hooks/hotkey-capture.hooks";
import {
  hasNewHeldKeys,
  uniqueHeldKeys,
} from "../../utils/hotkey-capture.utils";
import { ArrowRight } from "lucide-react";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { savePrimaryHotkey } from "../../actions/hotkey.actions";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  DICTATE_HOTKEY,
  getDefaultHotkeyCombosForAction,
} from "../../utils/keyboard.utils";
import { HotkeyBadge } from "../common/HotkeyBadge";
import { KeyPressSimulator } from "../common/KeyPressSimulator";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

const KeyCapturePreview = ({
  isListening,
  keysHeld,
  currentKeys,
}: {
  isListening: boolean;
  keysHeld: string[];
  currentKeys: string[];
}) => (
  <Box
    sx={{
      bgcolor: "level2",
      borderRadius: 2,
      p: 3,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      minHeight: 80,
      border: "2px solid",
      borderColor: isListening ? "primary.main" : "transparent",
    }}
  >
    {isListening ? (
      keysHeld.length > 0 ? (
        <KeyPressSimulator keys={keysHeld} />
      ) : (
        <Box
          sx={{
            height: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Press your new key combo..." />
          </Typography>
        </Box>
      )
    ) : (
      <KeyPressSimulator keys={currentKeys} />
    )}
  </Box>
);

export const KeybindingsForm = () => {
  const [isListening, setIsListening] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const keysHeld = useAppStore((s) => s.keysHeld);
  const hotkeys = useAppStore((state) =>
    state.settings.hotkeyIds
      .map((id) => state.hotkeyById[id])
      .filter((hotkey) => hotkey?.actionName === DICTATE_HOTKEY),
  );

  const defaultCombos = getDefaultHotkeyCombosForAction(DICTATE_HOTKEY);
  const [primaryHotkey] = hotkeys;
  const currentKeys =
    primaryHotkey?.keys ?? (defaultCombos.length > 0 ? defaultCombos[0] : []);

  const lastEmittedRef = useRef<string[]>(currentKeys);
  const previousKeysHeldRef = useRef<string[]>([]);

  useHotkeyCapture(isListening);
  useEffect(() => {
    if (!isListening) return;
    const focusTimer = setTimeout(() => boxRef.current?.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [isListening]);

  useEffect(() => {
    if (!isListening) {
      previousKeysHeldRef.current = [];
      return;
    }

    const held = uniqueHeldKeys(keysHeld);

    const previousHeld = previousKeysHeldRef.current;
    if (previousHeld.length > 0 && held.length < previousHeld.length) {
      setIsListening(false);
      previousKeysHeldRef.current = [];
      return;
    }

    previousKeysHeldRef.current = held;

    if (held.length === 0) return;

    if (held.length === 1 && held[0] === "Escape") {
      setIsListening(false);
      return;
    }

    const last = lastEmittedRef.current ?? [];
    if (hasNewHeldKeys(held, last)) {
      lastEmittedRef.current = held;
      void saveKey(held);
    }
  }, [keysHeld, isListening]);

  const saveKey = async (keys: string[]) => {
    await savePrimaryHotkey(DICTATE_HOTKEY, keys);
  };

  const handleChangeShortcut = () => {
    trackButtonClick("onboarding_change_hotkey");
    lastEmittedRef.current = [];
    setIsListening(true);
  };

  const handleConfirm = () => {
    trackButtonClick("onboarding_hotkey_works");
    goToOnboardingPage("micCheck");
  };

  const form = (
    <OnboardingFormLayout back={<BackButton />} actions={<div />}>
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
          <FormattedMessage defaultMessage="Test your keyboard shortcut" />
        </Typography>
        <Typography
          variant="body1"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="The {recommendedKey} key works great for most users."
            values={{
              recommendedKey: <HotkeyBadge keys={defaultCombos[0] ?? []} />,
            }}
          />
        </Typography>
      </Stack>
    </OnboardingFormLayout>
  );

  const handleBlur = (e: React.FocusEvent) => {
    if (boxRef.current?.contains(e.relatedTarget as Node)) {
      return;
    }
    setIsListening(false);
  };

  const rightContent = (
    <Stack
      ref={boxRef}
      tabIndex={0}
      onBlur={handleBlur}
      spacing={3}
      sx={{
        bgcolor: "level1",
        borderRadius: 2,
        p: 4,
        maxWidth: 400,
        outline: "none",
      }}
    >
      <Typography
        variant="h6"
        sx={{
          fontWeight: 600,
        }}
      >
        {isListening ? (
          <FormattedMessage defaultMessage="Press your hotkey combo, then release" />
        ) : (
          <FormattedMessage defaultMessage="Does the key light up green when pressed?" />
        )}
      </Typography>

      <KeyCapturePreview
        isListening={isListening}
        keysHeld={keysHeld}
        currentKeys={currentKeys}
      />

      <Stack
        direction="row"
        spacing={2}
        sx={{
          justifyContent: "flex-end",
        }}
      >
        <Button
          variant="text"
          onClick={handleChangeShortcut}
          disabled={isListening}
        >
          <FormattedMessage defaultMessage="Change hotkey" />
        </Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          endIcon={<ArrowRight size={18} strokeWidth={1.9} />}
          disabled={isListening}
        >
          <FormattedMessage defaultMessage="It works" />
        </Button>
      </Stack>
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
