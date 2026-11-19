import { ArrowRight } from "lucide-react";
import { Box, Button, Stack, Typography } from "@mui/material";
import type { Hotkey } from "@maus-inc/types";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { getHotkeyRepo } from "../../repos";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { registerHotkeys } from "../../utils/app.utils";
import { createId } from "../../utils/id.utils";
import {
  beginOnboardingHotkeyWrite,
  enqueueHotkeyWrite,
  finishOnboardingHotkeyWrite,
  markOnboardingSyncNeeded,
  markOptimisticHotkeyWrite,
  onboardingHotkeyRevision,
  onboardingSavedHotkey,
  setOnboardingSavedHotkey,
  takeOnboardingSyncNeeded,
} from "../../utils/hotkey-write-queue";
import {
  beginLocalDataWrite,
  type LocalDataWriteLease,
} from "../../utils/local-data-write-gate";
import {
  DICTATE_HOTKEY,
  getDefaultHotkeyCombosForAction,
  isModifierOnlyCombo,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { HotkeyBadge } from "../common/HotkeyBadge";
import { KeyPressSimulator } from "../common/KeyPressSimulator";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

const rollbackHotkey = (
  value: Hotkey,
  revision: number | undefined,
  lease: LocalDataWriteLease,
): boolean => {
  if (revision !== onboardingHotkeyRevision(value.id)) return false;
  let rolledBack = false;
  produceAppState((draft) => {
    const current = draft.hotkeyById[value.id];
    if (
      current?.actionName !== value.actionName ||
      current.keys.length !== value.keys.length ||
      !current.keys.every((key, index) => key === value.keys[index])
    )
      return;
    rolledBack = true;
    const saved = onboardingSavedHotkey(value.id);
    if (saved) draft.hotkeyById[value.id] = saved;
    else {
      Reflect.deleteProperty(draft.hotkeyById, value.id);
      draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
        (id) => id !== value.id,
      );
    }
  }, lease);
  return rolledBack;
};

export const KeybindingsForm = () => {
  const intl = useIntl();
  const [isListening, setIsListening] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const keysHeld = useAppStore((s) => s.keysHeld);
  const hotkeyStrategy = useAppStore((s) => s.hotkeyStrategy);
  const hotkeys = useAppStore((state) =>
    state.settings.hotkeyIds
      .map((id) => state.hotkeyById[id])
      .filter((hotkey) => hotkey?.actionName === DICTATE_HOTKEY),
  );

  const defaultCombos = getDefaultHotkeyCombosForAction(DICTATE_HOTKEY);
  const [primaryHotkey] = hotkeys;
  const currentKeys =
    primaryHotkey?.keys ?? (defaultCombos.length > 0 ? defaultCombos[0] : []);

  const previousKeysHeldRef = useRef<string[]>([]);
  const captureArmedRef = useRef(false);

  useEffect(() => {
    if (!isListening) return;
    produceAppState((draft) => {
      draft.isRecordingHotkey = true;
    });
    const cancelOnWindowBlur = () => setIsListening(false);
    window.addEventListener("blur", cancelOnWindowBlur);
    return () => {
      window.removeEventListener("blur", cancelOnWindowBlur);
      produceAppState((draft) => {
        draft.isRecordingHotkey = false;
      });
    };
  }, [isListening]);

  useEffect(() => {
    if (!isListening) {
      previousKeysHeldRef.current = [];
      return;
    }

    const seen = new Set<string>();
    const held = keysHeld.filter((k: string) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!captureArmedRef.current) {
      if (held.length === 0) captureArmedRef.current = true;
      return;
    }

    const previousHeld = previousKeysHeldRef.current;
    if (previousHeld.length > 0 && held.length < previousHeld.length) {
      setIsListening(false);
      previousKeysHeldRef.current = [];
      if (hotkeyStrategy === "bridge" && isModifierOnlyCombo(previousHeld)) {
        showErrorSnackbar(
          intl.formatMessage({
            defaultMessage:
              "Hotkey must include a non-modifier key (e.g. a letter or number)",
          }),
        );
      } else {
        saveKey(previousHeld);
      }
      return;
    }

    previousKeysHeldRef.current = held;

    if (held.length === 1 && held[0] === "Escape") {
      previousKeysHeldRef.current = [];
      setIsListening(false);
    }
  }, [keysHeld, isListening, hotkeyStrategy, intl]);

  const saveKey = (keys: string[]) => {
    const releaseWrite = beginLocalDataWrite();
    if (!releaseWrite) {
      showErrorSnackbar(
        intl.formatMessage({
          defaultMessage: "Failed to save hotkey. Please try again.",
        }),
      );
      return;
    }
    const newValue = {
      id: primaryHotkey?.id ?? createId(),
      actionName: DICTATE_HOTKEY,
      keys,
    };

    beginOnboardingHotkeyWrite(newValue.id, primaryHotkey);
    markOptimisticHotkeyWrite(newValue.actionName, newValue.id);
    const revision = onboardingHotkeyRevision(newValue.id);
    produceAppState((draft) => {
      registerHotkeys(draft, [newValue]);
      if (!draft.settings.hotkeyIds.includes(newValue.id)) {
        draft.settings.hotkeyIds.push(newValue.id);
      }
      draft.settings.hotkeysStatus = "success";
    }, releaseWrite.lease);
    enqueueHotkeyWrite(async () => {
      try {
        try {
          await getHotkeyRepo().saveHotkey(newValue, releaseWrite.lease);
          setOnboardingSavedHotkey(newValue.id, newValue);
          markOnboardingSyncNeeded();
        } catch (error) {
          console.error("Failed to save hotkey", error);
          if (rollbackHotkey(newValue, revision, releaseWrite.lease))
            markOnboardingSyncNeeded();
          showErrorSnackbar(
            intl.formatMessage({
              defaultMessage: "Failed to save hotkey. Please try again.",
            }),
          );
        } finally {
          finishOnboardingHotkeyWrite(newValue.id);
        }
        if (takeOnboardingSyncNeeded()) {
          try {
            await syncHotkeyCombosToNative();
          } catch (error) {
            console.error("Failed to synchronize hotkey", error);
            showErrorSnackbar(
              intl.formatMessage({
                defaultMessage:
                  "Could not activate the current hotkey. Please try again.",
              }),
            );
          }
        }
      } finally {
        releaseWrite();
      }
    }).catch((error) =>
      console.error("Unexpected hotkey write failure", error),
    );
  };

  const handleChangeShortcut = () => {
    trackButtonClick("onboarding_change_hotkey");
    previousKeysHeldRef.current = [];
    captureArmedRef.current = getAppState().keysHeld.length === 0;
    setIsListening(true);
    setTimeout(() => {
      boxRef.current?.focus();
    }, 0);
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
          <>
            <Box
              component="span"
              sx={{ "@media (forced-colors: active)": { display: "none" } }}
            >
              <FormattedMessage defaultMessage="Does the key light up green when pressed?" />
            </Box>
            <Box
              component="span"
              sx={{
                display: "none",
                "@media (forced-colors: active)": { display: "inline" },
              }}
            >
              <FormattedMessage defaultMessage="Does the shortcut highlight when pressed?" />
            </Box>
          </>
        )}
      </Typography>

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
