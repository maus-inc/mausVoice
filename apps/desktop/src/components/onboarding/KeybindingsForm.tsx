import { ArrowRight } from "lucide-react";
import { Box, Button, Stack, Typography } from "@mui/material";
import type { Hotkey } from "@maus-inc/types";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { registerHotkeys } from "../../utils/app.utils";
import { createId } from "../../utils/id.utils";
import { beginLocalDataWrite } from "../../utils/local-data-write-gate";
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

// Writes can outlive a mounted onboarding page. Keep their ordering and
// rollback snapshots shared across remounts of this form.
let saveQueue: Promise<void> = Promise.resolve();
let pendingSaves = 0;
const pendingById = new Map<string, number>();
const lastSaved = new Map<string, Hotkey | undefined>();
const saveRevision = new Map<string, number>();
let needsSync = false;

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

    const pendingForId = pendingById.get(newValue.id) ?? 0;
    if (pendingForId === 0) {
      lastSaved.set(newValue.id, primaryHotkey);
    }
    pendingById.set(newValue.id, pendingForId + 1);
    pendingSaves += 1;
    const revision = (saveRevision.get(newValue.id) ?? 0) + 1;
    saveRevision.set(newValue.id, revision);
    produceAppState((draft) => {
      registerHotkeys(draft, [newValue]);
      if (!draft.settings.hotkeyIds.includes(newValue.id)) {
        draft.settings.hotkeyIds.push(newValue.id);
      }
      draft.settings.hotkeysStatus = "success";
    }, releaseWrite.lease);
    saveQueue = saveQueue.then(async () => {
      try {
        try {
          await getHotkeyRepo().saveHotkey(newValue, releaseWrite.lease);
          lastSaved.set(newValue.id, newValue);
          needsSync = true;
        } catch (error) {
          console.error("Failed to save hotkey", error);
          let rolledBack = false;
          if (revision === saveRevision.get(newValue.id)) {
            produceAppState((draft) => {
              const current = draft.hotkeyById[newValue.id];
              if (
                !current ||
                current.actionName !== newValue.actionName ||
                current.keys.length !== newValue.keys.length ||
                !current.keys.every(
                  (key, index) => key === newValue.keys[index],
                )
              )
                return;
              rolledBack = true;
              const savedHotkey = lastSaved.get(newValue.id);
              if (savedHotkey) {
                draft.hotkeyById[newValue.id] = savedHotkey;
              } else {
                delete draft.hotkeyById[newValue.id];
                draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
                  (id) => id !== newValue.id,
                );
              }
            }, releaseWrite.lease);
          }
          if (rolledBack) needsSync = true;
          showErrorSnackbar(
            intl.formatMessage({
              defaultMessage: "Failed to save hotkey. Please try again.",
            }),
          );
        } finally {
          pendingSaves -= 1;
          const remaining = (pendingById.get(newValue.id) ?? 1) - 1;
          if (remaining === 0) {
            pendingById.delete(newValue.id);
            lastSaved.delete(newValue.id);
            saveRevision.delete(newValue.id);
          } else {
            pendingById.set(newValue.id, remaining);
          }
        }
        if (pendingSaves === 0 && needsSync) {
          needsSync = false;
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
    });
  };

  const handleChangeShortcut = () => {
    trackButtonClick("onboarding_change_hotkey");
    previousKeysHeldRef.current = [];
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
