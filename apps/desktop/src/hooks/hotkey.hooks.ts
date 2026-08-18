import {
  ActivationController,
  processFireCombo,
  type FireComboState,
  useHotkeyFire as useHotkeyFireGeneric,
  useHotkeyHoldMany as useHotkeyHoldManyGeneric,
} from "@maus-inc/desktop-utils";
import { useEffect, useMemo, useRef } from "react";
import type { AppState } from "../state/app.state";
import { getAppState, useAppStore } from "../store";
import { getHotkeyCombosForAction } from "../utils/keyboard.utils";

type HoldAction = {
  actionName: string;
  controller: ActivationController;
  allowedAdditionalKeys?: string[];
};

type HotkeyHoldArgs = HoldAction & { isDisabled?: boolean };

export const useHotkeyHold = (args: HotkeyHoldArgs) => {
  const actions = useMemo(
    () => [
      {
        actionName: args.actionName,
        controller: args.controller,
        allowedAdditionalKeys: args.allowedAdditionalKeys,
      },
    ],
    [args.actionName, args.controller, args.allowedAdditionalKeys],
  );
  useHotkeyHoldMany({ actions, isDisabled: args.isDisabled });
};

export const useHotkeyHoldMany = (args: {
  actions: HoldAction[];
  isDisabled?: boolean;
}) => {
  const keysHeld = useAppStore((s) => s.keysHeld);
  const isRecordingHotkey = useAppStore((state) => state.isRecordingHotkey);
  const hotkeyById = useAppStore((state) => state.hotkeyById);
  const hotkeyTriggers = useAppStore((state) => state.hotkeyTriggers);

  const combosByAction = useMemo(() => {
    const map: Record<string, string[][]> = {};
    const state = getAppState();
    for (const action of args.actions) {
      map[action.actionName] = getHotkeyCombosForAction(
        state,
        action.actionName,
      );
    }
    return map;
  }, [hotkeyById, args.actions]);

  const genericActions = useMemo(
    () =>
      args.actions.map((action) => ({
        controller: action.controller,
        combos: combosByAction[action.actionName] ?? [],
        triggerCount: hotkeyTriggers[action.actionName] ?? 0,
        allowedAdditionalKeys: action.allowedAdditionalKeys,
      })),
    [args.actions, combosByAction, hotkeyTriggers],
  );

  useEffect(() => {
    return () => {
      for (const action of args.actions) {
        action.controller.dispose();
      }
    };
  }, [args.actions]);

  useHotkeyHoldManyGeneric({
    actions: genericActions,
    keysHeld,
    isDisabled: Boolean(args.isDisabled || isRecordingHotkey),
  });
};

export const useHotkeyFire = (args: {
  actionName: string;
  isDisabled?: boolean;
  onFire?: () => void;
}) => {
  const keysHeld = useAppStore((state) => state.keysHeld);
  const isRecordingHotkey = useAppStore((state) => state.isRecordingHotkey);
  const combos = useAppStore((state) =>
    getHotkeyCombosForAction(state, args.actionName),
  );
  const triggerCount = useAppStore(
    (s) => s.hotkeyTriggers[args.actionName] ?? 0,
  );

  useHotkeyFireGeneric({
    combos,
    triggerCount,
    keysHeld,
    isDisabled: Boolean(args.isDisabled || isRecordingHotkey),
    onFire: args.onFire,
  });
};

type FireManyAction = {
  actionName: string;
  onFire: () => void;
};

const processFireManyAction = (args: {
  action: FireManyAction;
  state: AppState;
  previous: Set<string>;
  current: Set<string>;
  wasDisabled: boolean;
  activeIds: Set<string>;
  comboStates: Map<string, FireComboState>;
}): boolean => {
  const {
    action,
    state,
    previous,
    current,
    wasDisabled,
    activeIds,
    comboStates,
  } = args;
  const combos = getHotkeyCombosForAction(state, action.actionName);
  let shouldFire = false;

  for (const combo of combos) {
    const required = new Set(combo.map((key) => key.toLowerCase()));
    if (required.size === 0) continue;

    const id = `${action.actionName}:${[...required]
      .sort((left, right) => left.localeCompare(right))
      .join("+")}`;
    const transition = processFireCombo({
      combo,
      previous,
      current,
      wasDisabled,
      states: comboStates,
      activeIds,
      stateKey: id,
      previousState: comboStates.get(id),
    });
    comboStates.set(id, transition.state);
    shouldFire = transition.shouldFire || shouldFire;
  }

  return shouldFire;
};

const processBridgeTriggers = (
  current: Record<string, number>,
  previous: Record<string, number>,
  actionsByName: Map<string, FireManyAction>,
): void => {
  for (const [id, count] of Object.entries(current)) {
    if (count > (previous[id] ?? 0)) actionsByName.get(id)?.onFire();
  }
};

/**
 * Dynamic counterpart to useHotkeyFire.  React hooks cannot be called inside a
 * map whose length changes as tones are added, so this hook owns one release
 * detector for the whole registry while preserving the same contaminated
 * combo semantics as the single-action hook.
 */
export const useHotkeyFireMany = (args: {
  actions: FireManyAction[];
  isDisabled?: boolean;
}) => {
  const keysHeld = useAppStore((state) => state.keysHeld);
  const hotkeyById = useAppStore((state) => state.hotkeyById);
  const hotkeyTriggers = useAppStore((state) => state.hotkeyTriggers);
  const isRecordingHotkey = useAppStore((state) => state.isRecordingHotkey);
  const previousKeysRef = useRef<string[]>([]);
  const comboStateRef = useRef(new Map<string, FireComboState>());
  const wasDisabledRef = useRef(false);
  const previousTriggersRef = useRef<Record<string, number>>({});

  const actionsByName = useMemo(
    () => new Map(args.actions.map((action) => [action.actionName, action])),
    [args.actions],
  );

  useEffect(() => {
    const disabled = Boolean(args.isDisabled || isRecordingHotkey);
    const normalize = (key: string) => key.toLowerCase();
    const previous = new Set(previousKeysRef.current.map(normalize));
    const current = new Set(keysHeld.map(normalize));
    const activeIds = new Set<string>();
    const state = getAppState();

    if (!disabled) {
      for (const action of args.actions) {
        const shouldFire = processFireManyAction({
          action,
          state,
          previous,
          current,
          wasDisabled: wasDisabledRef.current,
          activeIds,
          comboStates: comboStateRef.current,
        });
        if (shouldFire) action.onFire();
      }
      wasDisabledRef.current = false;
      processBridgeTriggers(
        hotkeyTriggers,
        previousTriggersRef.current,
        actionsByName,
      );
    } else {
      comboStateRef.current.clear();
      wasDisabledRef.current = true;
    }

    for (const id of comboStateRef.current.keys()) {
      if (!activeIds.has(id)) comboStateRef.current.delete(id);
    }
    previousTriggersRef.current = { ...hotkeyTriggers };
    previousKeysRef.current = keysHeld;
  }, [
    args.actions,
    args.isDisabled,
    hotkeyById,
    hotkeyTriggers,
    isRecordingHotkey,
    keysHeld,
    actionsByName,
  ]);
};
