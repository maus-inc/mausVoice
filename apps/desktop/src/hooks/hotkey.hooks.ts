import {
  ActivationController,
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

type ComboState = { contaminated: boolean; previousExact: boolean };

type ComboTransition = {
  state: ComboState;
  shouldFire: boolean;
};

const updateComboTransition = (
  state: ComboState,
  required: Set<string>,
  previous: Set<string>,
  current: Set<string>,
): ComboTransition => {
  const previousIncludesAll = [...required].every((key) => previous.has(key));
  const currentIncludesAll = [...required].every((key) => current.has(key));
  const currentExact = currentIncludesAll && current.size === required.size;
  const shouldFire =
    state.previousExact && !currentIncludesAll && !state.contaminated;

  if (!previousIncludesAll && currentIncludesAll) {
    state.contaminated = false;
  }
  if (currentIncludesAll && !currentExact) {
    state.contaminated = true;
  }
  state.previousExact = currentExact;
  if (!currentIncludesAll) {
    state.contaminated = false;
  }

  return { state, shouldFire };
};

const processFireManyAction = (args: {
  action: FireManyAction;
  state: AppState;
  previous: Set<string>;
  current: Set<string>;
  activeIds: Set<string>;
  comboStates: Map<string, ComboState>;
}): void => {
  const { action, state, previous, current, activeIds, comboStates } = args;
  const normalize = (key: string) => key.toLowerCase();
  const combos = getHotkeyCombosForAction(state, action.actionName);

  for (const combo of combos) {
    const required = new Set(combo.map(normalize));
    if (required.size === 0) continue;

    const id = `${action.actionName}:${[...required]
      .sort((left, right) => left.localeCompare(right))
      .join("+")}`;
    activeIds.add(id);
    const comboState = comboStates.get(id) ?? {
      contaminated: false,
      previousExact: false,
    };
    const transition = updateComboTransition(
      comboState,
      required,
      previous,
      current,
    );
    comboStates.set(id, transition.state);
    if (transition.shouldFire) action.onFire();
  }
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
  const comboStateRef = useRef(
    new Map<string, { contaminated: boolean; previousExact: boolean }>(),
  );
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
        processFireManyAction({
          action,
          state,
          previous,
          current,
          activeIds,
          comboStates: comboStateRef.current,
        });
      }
      processBridgeTriggers(
        hotkeyTriggers,
        previousTriggersRef.current,
        actionsByName,
      );
    } else {
      comboStateRef.current.clear();
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
