import { invoke } from "@tauri-apps/api/core";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState } from "../../store";
import { ActivationController } from "../../utils/activation.utils";
import { resetHotkeyFilter } from "../../utils/hotkey-filter.utils";
import type { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import { getEffectivePillVisibility } from "../../utils/user.utils";

type StartDispatched = (operation: number) => void;

export type RecordingHandlers = {
  startDictationRecording: (
    onDispatched?: StartDispatched,
    deactivation?: AbortSignal,
  ) => Promise<number | undefined>;
  stopDictationRecording: (expectedOperation?: number) => Promise<void>;
  startAgentRecording: (
    onDispatched?: StartDispatched,
    deactivation?: AbortSignal,
  ) => Promise<number | undefined>;
  stopAgentRecording: (expectedOperation?: number) => Promise<void>;
  startRecording: (args: {
    mode: RecordingMode;
    language?: string | null;
    onNativeStartDispatched?: StartDispatched;
    deactivation?: AbortSignal;
  }) => Promise<number | undefined>;
  stopRecording: (expectedOperation?: number) => Promise<void>;
};

/** Apply only committed handlers; long-lived controllers must not retain stale callbacks. */
export function useRecordingControllerBindings(
  ref: { current: RecordingHandlers | null },
  handlers: RecordingHandlers,
): void {
  useLayoutEffect(() => {
    ref.current = handlers;
    return () => {
      if (ref.current === handlers) ref.current = null;
    };
  }, [ref, handlers]);
}

const revealPillForActivityIfHidden = async (): Promise<void> => {
  if (
    getEffectivePillVisibility(
      getAppState().userPrefs?.dictationPillVisibility,
    ) !== "hidden"
  )
    return;
  try {
    await invoke("set_pill_visibility", { visibility: "while_active" });
  } catch (error) {
    getLogger().error(`Failed to reveal pill: ${error}`);
  }
};

function createRecordingController(
  start: (
    onDispatched: StartDispatched,
    deactivation: AbortSignal,
  ) => Promise<number | undefined> | undefined,
  stop: (operation: number) => Promise<void> | undefined,
  holdToTalk = false,
): ActivationController {
  type Run = {
    operation?: number;
    released: boolean;
    stopPromise?: Promise<void>;
  };
  let run: Run | null = null;
  const stopRun = (owner: Run) => {
    if (owner.operation === undefined || owner.stopPromise) return;
    try {
      owner.stopPromise = Promise.resolve(stop(owner.operation));
    } catch (error) {
      owner.stopPromise = Promise.reject(error);
    }
    void owner.stopPromise.catch(() => undefined);
  };
  const controller = new ActivationController(
    async () => {
      run = null;
      const deactivation = controller.activationDeactivationSignal;
      if (!deactivation || deactivation.aborted) return;
      const owner: Run = { released: false };
      run = owner;
      const generation = controller.resetGeneration;
      deactivation.addEventListener(
        "abort",
        () => {
          owner.released = true;
          if (generation === controller.resetGeneration) stopRun(owner);
        },
        { once: true },
      );
      // Pill visibility is cosmetic. A stalled native reply must not delay
      // opening or releasing the microphone.
      void revealPillForActivityIfHidden();
      const started = await start((operation) => {
        if (generation !== controller.resetGeneration) return;
        owner.operation = operation;
        if (owner.released) stopRun(owner);
      }, deactivation);
      if (generation !== controller.resetGeneration) return;
      if (owner.operation === undefined) owner.operation = started;
      if (owner.released) stopRun(owner);
    },
    async () => {
      const owner = run;
      run = null;
      if (!owner) return;
      stopRun(owner);
      await owner.stopPromise;
    },
    holdToTalk,
  );
  return controller;
}

/** Own activation-controller identities and the shared native hotkey reset. */
export function useRecordingControllers(
  entries: ReturnType<typeof getAdditionalLanguageEntries>,
) {
  const handlersRef = useRef<RecordingHandlers | null>(null);
  const dictationController = useMemo(
    () =>
      createRecordingController(
        (onDispatched, deactivation) =>
          handlersRef.current?.startDictationRecording(
            onDispatched,
            deactivation,
          ),
        (operation) => handlersRef.current?.stopDictationRecording(operation),
        true,
      ),
    [],
  );
  const agentController = useMemo(
    () =>
      createRecordingController(
        (onDispatched, deactivation) =>
          handlersRef.current?.startAgentRecording(onDispatched, deactivation),
        (operation) => handlersRef.current?.stopAgentRecording(operation),
      ),
    [],
  );
  const languageControllersRef = useRef(
    new Map<string, ActivationController>(),
  );
  const languages = useMemo(() => {
    const registry = new Map<string, ActivationController>();
    const controllers = entries.map((entry) => {
      const key = JSON.stringify([entry.actionName, entry.language]);
      const controller =
        languageControllersRef.current.get(key) ??
        createRecordingController(
          (onDispatched, deactivation) =>
            handlersRef.current?.startRecording({
              mode: "dictate",
              language: entry.language,
              onNativeStartDispatched: onDispatched,
              deactivation,
            }),
          (operation) => handlersRef.current?.stopRecording(operation),
        );
      registry.set(key, controller);
      return { actionName: entry.actionName, controller };
    });
    return { controllers, registry };
  }, [entries]);
  useLayoutEffect(() => {
    languageControllersRef.current = languages.registry;
  }, [languages]);
  const additionalLanguageControllers = languages.controllers;
  const hardResetHotkeyState = useCallback(() => {
    dictationController.forceReset();
    agentController.forceReset();
    for (const { controller } of additionalLanguageControllers)
      controller.forceReset();
    produceAppState((draft) => {
      draft.keysHeld = [];
    });
    invoke("reset_key_listener_state").catch((error) =>
      getLogger().verbose(`Failed to reset key listener state: ${error}`),
    );
    resetHotkeyFilter();
  }, [dictationController, agentController, additionalLanguageControllers]);
  return {
    handlersRef,
    dictationController,
    agentController,
    additionalLanguageControllers,
    hardResetHotkeyState,
  };
}
