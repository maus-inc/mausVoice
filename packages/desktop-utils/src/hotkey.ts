import { useEffect, useMemo, useRef } from "react";
import type { ActivationController } from "./activation";

type HoldAction = {
  controller: ActivationController;
  combos: string[][];
  triggerCount: number;
};

export type UseHotkeyHoldManyArgs = {
  actions: HoldAction[];
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
    const normalize = (key: string) => key.toLowerCase();

    const matchesCombo = (held: string[], combo: string[]) => {
      if (combo.length === 0) {
        return false;
      }

      const uniqueHeld = Array.from(new Set(held.map((key) => normalize(key))));
      const required = Array.from(new Set(combo.map((key) => normalize(key))));

      if (uniqueHeld.length !== required.length) {
        return false;
      }

      const heldSet = new Set(uniqueHeld);
      return required.every((key) => heldSet.has(key));
    };

    for (const action of actions) {
      const availableCombos = action.combos;
      const wasPressed = wasPressedRef.current.get(action.controller) ?? false;
      const isPressed = availableCombos.some((combo) =>
        matchesCombo(keysHeld, combo),
      );

      if (isDisabled) {
        wasPressedRef.current.set(action.controller, isPressed);
        action.controller.reset();
        continue;
      }

      if (
        action.controller.isActive &&
        !wasPressed &&
        !action.controller.hasHadRelease
      ) {
        action.controller.forceReset();
      }

      if (availableCombos.length === 0) {
        wasPressedRef.current.set(action.controller, false);
        action.controller.reset();
        continue;
      }

      if (isPressed && !wasPressed) {
        if (action.controller.shouldIgnoreActivation) {
          wasPressedRef.current.set(action.controller, isPressed);
          continue;
        }

        action.controller.handlePress();
      } else if (!isPressed && wasPressed) {
        action.controller.clearIgnore();
        action.controller.handleRelease();
      }

      wasPressedRef.current.set(action.controller, isPressed);
    }
  }, [keysHeld, combosSignature, actions, isDisabled]);

  const triggerSignature = useMemo(
    () => actions.map((a) => a.triggerCount).join(","),
    [actions],
  );
  const prevTriggerCountsRef = useRef<Map<ActivationController, number>>(
    new Map(),
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
  const requiredSet = new Set(combo.map((key) => key.toLowerCase()));
  const previousIncludesAll = Array.from(requiredSet).every((key) =>
    previousSet.has(key),
  );
  const currentIncludesAll = Array.from(requiredSet).every((key) =>
    currentSet.has(key),
  );
  const previousExact =
    previousIncludesAll && previousSet.size === requiredSet.size;
  const currentExact =
    currentIncludesAll && currentSet.size === requiredSet.size;

  if (wasDisabled && currentIncludesAll) {
    comboState.contaminated = true;
  }

  if (!previousIncludesAll && currentIncludesAll) {
    comboState.contaminated = false;
  }

  if (currentIncludesAll && !currentExact) {
    comboState.contaminated = true;
  }

  let shouldFire = false;
  if (
    previousExact &&
    !currentExact &&
    !currentIncludesAll &&
    !comboState.contaminated
  ) {
    shouldFire = true;
  }

  if (!currentIncludesAll) {
    comboState.contaminated = false;
  }

  return shouldFire;
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
  const previousState =
    args.previousState ??
    states.get(id) ?? {
      contaminated: false,
      previousExact: false,
    };
  const previousIncludesAll = Array.from(required).every((key) =>
    previous.has(key),
  );
  const currentIncludesAll = Array.from(required).every((key) =>
    current.has(key),
  );
  const previousExact = previousIncludesAll && previous.size === required.size;
  const currentExact = currentIncludesAll && current.size === required.size;
  let contaminated = previousState.contaminated;

  if (wasDisabled && currentIncludesAll) contaminated = true;
  if (!previousIncludesAll && currentIncludesAll) contaminated = false;
  if (currentIncludesAll && !currentExact) contaminated = true;

  const shouldFire =
    previousExact && !currentExact && !currentIncludesAll && !contaminated;

  if (!currentIncludesAll) contaminated = false;
  const state = { contaminated, previousExact: currentExact };
  states.set(id, state);
  return { state, shouldFire };
};
