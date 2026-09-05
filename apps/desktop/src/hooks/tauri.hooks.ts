import {
  useTauriListen as useTauriListenBase,
  type ExpansionEventName,
  type ExpansionEventPayloads,
  type UseTauriListenOptions,
} from "@maus-inc/desktop-utils";
import { showErrorSnackbar } from "../actions/app.actions";

const surfaceError = (error: unknown) => showErrorSnackbar(error);

/**
 * Desktop-app wrapper around the shared `useTauriListen` hook that routes
 * handler/listen errors to the in-app snackbar instead of the default
 * `console.error` fallback.
 */
export const useTauriListen = <T = unknown>(
  eventName: string,
  callback: (event: T) => void | Promise<void>,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListenBase<T>(eventName, callback, {
    ...options,
    onError: surfaceError,
  });
};

/**
 * Listener for the expansion event contracts. The event name selects the
 * payload type through `ExpansionEventPayloads`, so every call site stays type
 * safe without a separate hook per event.
 */
export const useExpansionEventListener = <TEvent extends ExpansionEventName>(
  eventName: TEvent,
  callback: (payload: ExpansionEventPayloads[TEvent]) => void,
  options?: Omit<UseTauriListenOptions, "onError">,
) => {
  useTauriListen<ExpansionEventPayloads[TEvent]>(eventName, callback, options);
};
