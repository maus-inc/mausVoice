import {
  ActivationController,
  useHotkeyFire as useHotkeyFireGeneric,
  useHotkeyHoldMany as useHotkeyHoldManyGeneric,
} from "@maus-inc/desktop-utils";
import { useEffect, useMemo, useRef } from "react";
import { getAppState, useAppStore } from "../store";
import { getHotkeyCombosForAction } from "../utils/keyboard.utils";

type HoldAction = {
  actionName: string;
  controller: ActivationController;
  allowAdditionalKeys?: boolean;
};

type HotkeyHoldArgs = HoldAction & { isDisabled?: boolean };

export const useHotkeyHold = (args: HotkeyHoldArgs) => {
  const actions = useMemo(
    () => [
      {
        actionName: args.actionName,
        controller: args.controller,
        allowAdditionalKeys: args.allowAdditionalKeys,
      },
    ],
    [args.actionName, args.controller, args.allowAdditionalKeys],
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
        allowAdditionalKeys: action.allowAdditionalKeys,
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

  const actionSignature = useMemo(
    () => args.actions.map((action) => action.actionName).join("|"),
    [args.actions],
  );
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

    if (!disabled) {
      for (const action of args.actions) {
        const combos = getHotkeyCombosForAction(
          getAppState(),
          action.actionName,
        );
        for (const combo of combos) {
          const required = new Set(combo.map(normalize));
          if (required.size === 0) continue;
          const id = `${action.actionName}:${[...required].sort().join("+")}`;
          activeIds.add(id);
          const state = comboStateRef.current.get(id) ?? {
            contaminated: false,
            previousExact: false,
          };
          const previousIncludesAll = [...required].every((key) =>
            previous.has(key),
          );
          const currentIncludesAll = [...required].every((key) =>
            current.has(key),
          );
          const currentExact =
            currentIncludesAll && current.size === required.size;

          if (!previousIncludesAll && currentIncludesAll) {
            state.contaminated = false;
          }
          if (currentIncludesAll && !currentExact) {
            state.contaminated = true;
          }
          if (
            state.previousExact &&
            !currentIncludesAll &&
            !state.contaminated
          ) {
            action.onFire();
          }
          state.previousExact = currentExact;
          if (!currentIncludesAll) {
            state.contaminated = false;
          }
          comboStateRef.current.set(id, state);
        }
      }

      for (const [id, count] of Object.entries(hotkeyTriggers)) {
        const previousCount = previousTriggersRef.current[id] ?? 0;
        if (count > previousCount) {
          actionsByName.get(id)?.onFire();
        }
      }
    } else {
      comboStateRef.current.clear();
    }

    for (const id of comboStateRef.current.keys()) {
      if (!activeIds.has(id)) comboStateRef.current.delete(id);
    }
    previousTriggersRef.current = { ...hotkeyTriggers };
    previousKeysRef.current = keysHeld;
    // The signature makes adding/removing a style reset stale combo state.
    void actionSignature;
  }, [
    args.actions,
    args.isDisabled,
    actionSignature,
    hotkeyById,
    hotkeyTriggers,
    isRecordingHotkey,
    keysHeld,
    actionsByName,
  ]);
};
