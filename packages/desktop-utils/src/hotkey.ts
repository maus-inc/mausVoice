import { useEffect, useMemo, useRef } from "react";
import type { ActivationController } from "./activation";

/** One independently tracked hold binding, including its trigger snapshot. */
export type HotkeyHoldAction = {
  controller: ActivationController;
  combos: string[][];
  triggerCount: number;
  /**
   * Keys that may be held in addition to the required combo without
   * invalidating the match. Used for hold-to-talk tolerance (e.g. the
   * in-dictation style-switch arrows held alongside the activation key).
   */
  allowedAdditionalKeys?: string[];
};

export type UseHotkeyHoldManyArgs = {
  actions: HotkeyHoldAction[];
  keysHeld: string[];
  isDisabled?: boolean;
};

export type UseHotkeyHoldArgs = {
  controller: ActivationController;
  combos: string[][];
  triggerCount: number;
  keysHeld: string[];
  isDisabled?: boolean;
};

export type UseHotkeyFireArgs = {
  combos: string[][];
  triggerCount: number;
  keysHeld: string[];
  isDisabled?: boolean;
  onFire?: () => void;
};

const normalizeHoldKey = (key: string) => key.toLowerCase();

const matchesHoldCombo = (
  held: string[],
  combo: string[],
  allowedAdditionalKeys?: string[],
) => {
  if (combo.length === 0) {
    return false;
  }

  const uniqueHeld = Array.from(
    new Set(held.map((key) => normalizeHoldKey(key))),
  );
  const required = Array.from(
    new Set(combo.map((key) => normalizeHoldKey(key))),
  );
  const requiredSet = new Set(required);
  const allowed = new Set(
    (allowedAdditionalKeys ?? []).map((key) => normalizeHoldKey(key)),
  );

  const heldSet = new Set(uniqueHeld);
  // Every required key must be held.
  if (!required.every((key) => heldSet.has(key))) {
    return false;
  }
  // Every held key must be either required or explicitly allowed; any other
  // extra key (e.g. Fn+any-key) invalidates the hold-to-talk gesture.
  for (const key of uniqueHeld) {
    if (!requiredSet.has(key) && !allowed.has(key)) {
      return false;
    }
  }
  return true;
};

/** The hold gesture began: start capture unless this press is ignored. */
const beginHold = (controller: ActivationController): void => {
  if (!controller.shouldIgnoreActivation) controller.handlePress();
};

/** The hold gesture ended: clear any ignore latch and stop capture. */
const endHold = (controller: ActivationController): void => {
  controller.clearIgnore();
  controller.handleRelease();
};

const updateHoldAction = (
  action: HotkeyHoldAction,
  keysHeld: string[],
  isDisabled: boolean,
  wasPressedByController: Map<ActivationController, boolean>,
): void => {
  const availableCombos = action.combos;
  const wasPressed = wasPressedByController.get(action.controller) ?? false;
  const isPressed = availableCombos.some((combo) =>
    matchesHoldCombo(keysHeld, combo, action.allowedAdditionalKeys),
  );

  if (isDisabled) {
    wasPressedByController.set(action.controller, isPressed);
    action.controller.reset();
    return;
  }

  if (
    action.controller.isActive &&
    !wasPressed &&
    !action.controller.hasHadRelease
  ) {
    // A stale active controller may already own a recording. Resetting it
    // without deactivation would leave that capture running after rebinding.
    action.controller.reset();
  }

  if (availableCombos.length === 0) {
    wasPressedByController.set(action.controller, false);
    action.controller.reset();
    return;
  }

  if (isPressed && !wasPressed) beginHold(action.controller);
  else if (!isPressed && wasPressed) endHold(action.controller);

  wasPressedByController.set(action.controller, isPressed);
};

/**
 * Drives one or more {@link ActivationController}s from a press/release model
 * over the supplied keys. The consumer owns all state (held keys, combos per
 * action, trigger counts) and feeds it in; this hook is pure behavior.
 *
 * Controller lifetimes are the consumer's responsibility — this hook does not
 * call `.dispose()`.
 */
export const useHotkeyHoldMany = (args: UseHotkeyHoldManyArgs): void => {
  const isDisabled = Boolean(args.isDisabled);
  const { actions, keysHeld } = args;

  const combosSignature = useMemo(
    () => actions.map((a) => JSON.stringify(a.combos)).join("|"),
    [actions],
  );

  const wasPressedRef = useRef<Map<ActivationController, boolean>>(new Map());

  useEffect(() => {
    const current = new Set(actions.map((action) => action.controller));
    for (const controller of wasPressedRef.current.keys()) {
      if (!current.has(controller)) {
        wasPressedRef.current.delete(controller);
        controller.reset();
      }
    }
    for (const action of actions) {
      updateHoldAction(action, keysHeld, isDisabled, wasPressedRef.current);
    }
  }, [keysHeld, combosSignature, actions, isDisabled]);

  const triggerSignature = useMemo(
    () => actions.map((a) => a.triggerCount).join(","),
    [actions],
  );
  const prevTriggerCountsRef = useRef<WeakMap<ActivationController, number>>(
    new WeakMap(),
  );

  useEffect(() => {
    if (!isDisabled) {
      for (const action of actions) {
        const prev = prevTriggerCountsRef.current.get(action.controller) ?? 0;
        const curr = action.triggerCount;
        if (curr > prev) {
          action.controller.toggle();
        }
      }
    }
    for (const action of actions) {
      prevTriggerCountsRef.current.set(action.controller, action.triggerCount);
    }
  }, [triggerSignature, isDisabled, actions]);
};

/**
 * Single-controller variant of {@link useHotkeyHoldMany}.
 */
export const useHotkeyHold = (args: UseHotkeyHoldArgs): void => {
  const actions = useMemo(
    () => [
      {
        controller: args.controller,
        combos: args.combos,
        triggerCount: args.triggerCount,
      },
    ],
    [args.controller, args.combos, args.triggerCount],
  );
  useHotkeyHoldMany({
    actions,
    keysHeld: args.keysHeld,
    isDisabled: args.isDisabled,
  });
};

// A fresh complete press clears old contamination; extra keys and keys held
// across re-enabling prevent a tap until the combo is released again.
const fireComboTransition = (
  required: Set<string>,
  previous: Set<string>,
  current: Set<string>,
  wasDisabled: boolean,
  contaminated: boolean,
): FireComboTransition => {
  const previousIncludesAll = [...required].every((key) => previous.has(key));
  const currentIncludesAll = [...required].every((key) => current.has(key));
  const previousExact = previousIncludesAll && previous.size === required.size;
  const currentExact = currentIncludesAll && current.size === required.size;
  return {
    shouldFire: previousExact && !currentIncludesAll && !contaminated,
    state: {
      contaminated:
        currentIncludesAll &&
        (!currentExact ||
          (previousIncludesAll && (wasDisabled || contaminated))),
      previousExact: currentExact,
    },
  };
};

const updateComboState = ({
  combo,
  previousSet,
  currentSet,
  wasDisabled,
  comboState,
}: {
  combo: string[];
  previousSet: Set<string>;
  currentSet: Set<string>;
  wasDisabled: boolean;
  comboState: { contaminated: boolean };
}): boolean => {
  const transition = fireComboTransition(
    new Set(combo.map((key) => key.toLowerCase())),
    previousSet,
    currentSet,
    wasDisabled,
    comboState.contaminated,
  );
  comboState.contaminated = transition.state.contaminated;
  return transition.shouldFire;
};

const evaluateComboRelease = ({
  combos,
  previousSet,
  currentSet,
  wasDisabled,
  comboStates,
  activeComboIds,
}: {
  combos: string[][];
  previousSet: Set<string>;
  currentSet: Set<string>;
  wasDisabled: boolean;
  comboStates: Map<string, { contaminated: boolean }>;
  activeComboIds: Set<string>;
}): boolean => {
  let shouldFire = false;
  for (const combo of combos) {
    if (combo.length === 0) {
      continue;
    }

    const requiredSet = new Set(combo.map((key) => key.toLowerCase()));
    if (requiredSet.size === 0) {
      continue;
    }

    // Combo ids must be canonical: keys are already lowercased ASCII, so an
    // explicit "en" collation keeps the ordering locale-independent.
    const comboId = Array.from(requiredSet)
      .sort((a, b) => a.localeCompare(b, "en"))
      .join("+");
    activeComboIds.add(comboId);

    const comboState = comboStates.get(comboId) ?? { contaminated: false };
    const fires = updateComboState({
      combo,
      previousSet,
      currentSet,
      wasDisabled,
      comboState,
    });
    comboStates.set(comboId, comboState);

    if (fires) {
      shouldFire = true;
      break;
    }
  }

  return shouldFire;
};

/**
 * Fires `onFire` on a press-then-release (tap) that matches one of the combos,
 * and also when `triggerCount` increments. The consumer owns all state.
 */
export const useHotkeyFire = (args: UseHotkeyFireArgs): void => {
  const isDisabled = Boolean(args.isDisabled);
  const { combos, triggerCount, keysHeld, onFire } = args;

  const previousKeysHeldRef = useRef<string[]>([]);
  const comboStateRef = useRef<Map<string, { contaminated: boolean }>>(
    new Map(),
  );
  const wasDisabledRef = useRef(false);

  useEffect(() => {
    if (isDisabled) {
      previousKeysHeldRef.current = keysHeld;
      comboStateRef.current.clear();
      wasDisabledRef.current = true;
      return;
    }
    const wasDisabled = wasDisabledRef.current;
    wasDisabledRef.current = false;

    const toNormalizedSet = (keys: string[]) =>
      new Set(keys.map((key) => key.toLowerCase()));

    const previousSet = toNormalizedSet(previousKeysHeldRef.current);
    const currentSet = toNormalizedSet(keysHeld);
    const activeComboIds = new Set<string>();

    const shouldFire = evaluateComboRelease({
      combos,
      previousSet,
      currentSet,
      wasDisabled,
      comboStates: comboStateRef.current,
      activeComboIds,
    });

    for (const comboId of comboStateRef.current.keys()) {
      if (!activeComboIds.has(comboId)) {
        comboStateRef.current.delete(comboId);
      }
    }

    if (shouldFire) {
      onFire?.();
    }

    previousKeysHeldRef.current = keysHeld;
  }, [keysHeld, combos, isDisabled, onFire]);

  const prevTriggerCountRef = useRef(triggerCount);

  useEffect(() => {
    if (!isDisabled && triggerCount > prevTriggerCountRef.current) {
      onFire?.();
    }
    prevTriggerCountRef.current = triggerCount;
  }, [triggerCount, isDisabled, onFire]);
};

const normalizedKeys = (keys: string[]): Set<string> =>
  new Set(keys.map((key) => key.toLowerCase()));

export type FireComboState = {
  contaminated: boolean;
  previousExact: boolean;
};

export type FireComboTransition = {
  state: FireComboState;
  shouldFire: boolean;
};

export type FireComboArgs = {
  combo: string[];
  previous: Set<string>;
  current: Set<string>;
  wasDisabled: boolean;
  states: Map<string, FireComboState>;
  activeIds: Set<string>;
  stateKey?: string;
  previousState?: FireComboState;
};

/** Process one combo without mutating the caller's previous state object. */
export const processFireCombo = (args: FireComboArgs): FireComboTransition => {
  const { combo, previous, current, wasDisabled, states, activeIds } = args;
  if (combo.length === 0) {
    return {
      state: { contaminated: false, previousExact: false },
      shouldFire: false,
    };
  }

  const required = normalizedKeys(combo);
  if (required.size === 0) {
    return {
      state: { contaminated: false, previousExact: false },
      shouldFire: false,
    };
  }

  const id =
    args.stateKey ??
    Array.from(required)
      .sort((left, right) => left.localeCompare(right))
      .join("+");
  activeIds.add(id);
  const previousState = args.previousState ??
    states.get(id) ?? {
      contaminated: false,
      previousExact: false,
    };
  const transition = fireComboTransition(
    required,
    previous,
    current,
    wasDisabled,
    previousState.contaminated,
  );
  states.set(id, transition.state);
  return transition;
};
