import { Add, CancelOutlined, Close, RestartAlt } from "@mui/icons-material";
import { Button, IconButton, Stack, Switch, Typography } from "@mui/material";
import type { Hotkey } from "@maus-inc/types";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { registerHotkeys } from "../../utils/app.utils";
import { createId } from "../../utils/id.utils";
import {
  getDefaultHotkeyCombosForAction,
  getHotkeyCombosForAction,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { HotKey } from "../common/HotKey";

export type HotkeySettingProps = {
  title: ReactNode;
  description: ReactNode;
  actionName: string;
  buttonSize?: "small" | "medium";
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
};

const areCombosEqual = (a: string[], b: string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

const isSubsetOrEqualCombo = (a: string[], b: string[]) => {
  if (a.length === 0 || a.length > b.length) return false;
  const bSet = new Set(b.map((k) => k.toLowerCase()));
  return a.every((k) => bSet.has(k.toLowerCase()));
};

const HotkeyControls = ({
  primaryValue,
  primaryHotkey,
  additionalHotkeys,
  hasEnabledToggle,
  isPrimaryUsingDefault,
  defaultCombos,
  hasConflict,
  hotkeysCount,
  buttonLabel,
  buttonSize,
  onChangePrimary,
  onUpdateHotkey,
  onDeleteHotkey,
  onRevertPrimary,
  onDisable,
  onAdd,
}: {
  primaryValue: string[];
  primaryHotkey: Hotkey | undefined;
  additionalHotkeys: Hotkey[];
  hasEnabledToggle: boolean;
  isPrimaryUsingDefault: boolean;
  defaultCombos: string[][];
  hasConflict: boolean;
  hotkeysCount: number;
  buttonLabel: ReactNode;
  buttonSize: "small" | "medium";
  onChangePrimary: (keys: string[]) => void;
  onUpdateHotkey: (id: string, keys: string[]) => void;
  onDeleteHotkey: (id: string) => void;
  onRevertPrimary: () => void;
  onDisable: () => void;
  onAdd: () => void;
}) => {
  const intl = useIntl();
  return (
    <Stack
      spacing={1}
      sx={{
        alignItems: "flex-end",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
        }}
      >
        <HotKey value={primaryValue} onChange={onChangePrimary} />
        {hasEnabledToggle ? (
          <IconButton
            size="small"
            onClick={onDisable}
            aria-label={intl.formatMessage({ defaultMessage: "Disable hotkey" })}
          >
            <CancelOutlined color="disabled" />
          </IconButton>
        ) : (
          <>
            {primaryHotkey && defaultCombos.length === 0 && (
              <IconButton
                size="small"
                aria-label={intl.formatMessage({ defaultMessage: "Delete hotkey" })}
                onClick={() => onDeleteHotkey(primaryHotkey.id)}
              >
                <Close color="disabled" />
              </IconButton>
            )}
            {primaryHotkey &&
              defaultCombos.length > 0 &&
              !isPrimaryUsingDefault && (
                <IconButton
                  size="small"
                  aria-label={intl.formatMessage({
                    defaultMessage: "Revert to default hotkey",
                  })}
                  onClick={onRevertPrimary}
                >
                  <RestartAlt color="disabled" />
                </IconButton>
              )}
          </>
        )}
      </Stack>
      {!hasEnabledToggle &&
        additionalHotkeys.map((hotkey) => (
          <Stack
            key={hotkey.id}
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
            }}
          >
            <HotKey
              value={hotkey.keys}
              onChange={(keys) => onUpdateHotkey(hotkey.id, keys)}
            />
            <IconButton
              size="small"
              aria-label={intl.formatMessage({ defaultMessage: "Delete hotkey" })}
              onClick={() => onDeleteHotkey(hotkey.id)}
            >
              <Close color="disabled" />
            </IconButton>
          </Stack>
        ))}
      {hasConflict && (
        <Typography
          variant="caption"
          sx={{
            color: "warning.main",
            maxWidth: 220,
            textAlign: "right",
          }}
        >
          <FormattedMessage defaultMessage="This shortcut overlaps with another. One may trigger both actions." />
        </Typography>
      )}
      {!hasEnabledToggle && (hotkeysCount > 0 || defaultCombos.length > 0) && (
        <Button
          variant="text"
          startIcon={<Add />}
          size={buttonSize}
          sx={{ py: 0.5 }}
          onClick={onAdd}
        >
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {buttonLabel}
          </Typography>
        </Button>
      )}
    </Stack>
  );
};

export const HotkeySetting = ({
  title,
  description,
  actionName,
  buttonSize = "small",
  enabled,
  onEnabledChange,
}: HotkeySettingProps) => {
  const hasEnabledToggle = enabled !== undefined;
  const isEnabled = enabled ?? true;
  const hotkeys = useAppStore((state) =>
    state.settings.hotkeyIds
      .map((id) => state.hotkeyById[id])
      .filter(
        (hotkey): hotkey is Hotkey =>
          Boolean(hotkey) && hotkey.actionName === actionName,
      ),
  );
  const defaultCombos = getDefaultHotkeyCombosForAction(actionName);

  const hasConflict = useAppStore((state) => {
    const myCombos = getHotkeyCombosForAction(state, actionName);
    if (myCombos.length === 0) return false;

    const otherActions = new Set(
      Object.values(state.hotkeyById)
        .filter((h) => h.actionName !== actionName && h.keys.length > 0)
        .map((h) => h.actionName),
    );

    for (const otherAction of otherActions) {
      const otherCombos = getHotkeyCombosForAction(state, otherAction);
      for (const mine of myCombos) {
        for (const other of otherCombos) {
          if (
            isSubsetOrEqualCombo(mine, other) ||
            isSubsetOrEqualCombo(other, mine)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  });

  const saveKey = async (id?: string, keys?: string[]) => {
    const newValue: Hotkey = {
      id: id ?? createId(),
      actionName,
      keys: keys ?? [],
    };

    try {
      produceAppState((draft) => {
        registerHotkeys(draft, [newValue]);
        if (!draft.settings.hotkeyIds.includes(newValue.id)) {
          draft.settings.hotkeyIds.push(newValue.id);
        }
        draft.settings.hotkeysStatus = "success";
      });
      await getHotkeyRepo().saveHotkey(newValue);
      await syncHotkeyCombosToNative();
    } catch (error) {
      console.error("Failed to save hotkey", error);
      showErrorSnackbar("Failed to save hotkey. Please try again.");
    }
  };

  const handleDeleteHotkey = async (id: string) => {
    try {
      produceAppState((draft) => {
        delete draft.hotkeyById[id];
        draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
          (hid) => hid !== id,
        );
      });
      await getHotkeyRepo().deleteHotkey(id);
      await syncHotkeyCombosToNative();
    } catch (error) {
      console.error("Failed to delete hotkey", error);
      showErrorSnackbar("Failed to delete hotkey. Please try again.");
    }
  };

  const [primaryHotkey, ...additionalHotkeys] = hotkeys;
  const showDefaultAsPrimary = !primaryHotkey && defaultCombos.length > 0;
  const primaryValue =
    primaryHotkey?.keys ?? (showDefaultAsPrimary ? defaultCombos[0] : []);
  const isPrimaryUsingDefault =
    primaryHotkey != null &&
    defaultCombos.some((combo) => areCombosEqual(combo, primaryHotkey.keys));

  const handlePrimaryChange = (keys: string[]) => {
    if (primaryHotkey) {
      void saveKey(primaryHotkey.id, keys);
      return;
    }
    void saveKey(undefined, keys);
  };

  const handleRevertPrimary = () => {
    if (!primaryHotkey || defaultCombos.length === 0) {
      return;
    }
    void saveKey(primaryHotkey.id, defaultCombos[0]);
  };

  const buttonLabel =
    hotkeys.length === 0 && defaultCombos.length === 0 ? (
      <FormattedMessage defaultMessage="Set hotkey" />
    ) : (
      <FormattedMessage defaultMessage="Add another" />
    );

  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newEnabled = event.target.checked;
    onEnabledChange?.(newEnabled);

    // When enabling, set up a default hotkey if none exists
    if (newEnabled && !primaryHotkey && defaultCombos.length > 0) {
      void saveKey(undefined, defaultCombos[0]);
    }
  };

  const handleDisable = () => {
    onEnabledChange?.(false);
  };

  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{
        alignItems: "flex-start",
      }}
    >
      <Stack
        spacing={1}
        sx={{
          flex: 1,
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
          }}
        >
          <Typography
            variant="body1"
            sx={{
              fontWeight: "bold",
            }}
          >
            {title}
          </Typography>
          {hasEnabledToggle && (
            <Switch
              size="small"
              checked={isEnabled}
              onChange={handleToggle}
              slotProps={{
                input: {
                  "aria-label": "Enable hotkey",
                },
              }}
            />
          )}
        </Stack>
        <Typography variant="body2">{description}</Typography>
      </Stack>
      {isEnabled && (
        <HotkeyControls
          primaryValue={primaryValue}
          primaryHotkey={primaryHotkey}
          additionalHotkeys={additionalHotkeys}
          hasEnabledToggle={hasEnabledToggle}
          isPrimaryUsingDefault={isPrimaryUsingDefault}
          defaultCombos={defaultCombos}
          hasConflict={hasConflict}
          hotkeysCount={hotkeys.length}
          buttonLabel={buttonLabel}
          buttonSize={buttonSize}
          onChangePrimary={handlePrimaryChange}
          onUpdateHotkey={(id, keys) => void saveKey(id, keys)}
          onDeleteHotkey={(id) => void handleDeleteHotkey(id)}
          onRevertPrimary={handleRevertPrimary}
          onDisable={handleDisable}
          onAdd={() => void saveKey()}
        />
      )}
    </Stack>
  );
};
