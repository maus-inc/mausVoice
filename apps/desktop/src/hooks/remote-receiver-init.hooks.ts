import { canRunPostElevationInit } from "../actions/elevation.actions";
import { loadPairedRemoteDevices } from "../actions/paired-remote-device.actions";
import {
  refreshRemoteReceiverStatus,
  startRemoteReceiver,
} from "../actions/remote-receiver.actions";
import { clearUnavailableRemoteTarget } from "../actions/user.actions";
import { getAppState } from "../store";
import { getMyUserPreferences } from "../utils/user.utils";
import { getPairedRemoteDeviceById } from "../utils/device.utils";
import { useAsyncEffect } from "./async.hooks";

/** The queued conditional repair cannot overwrite a newer receiver selection. */
async function repairMissingTarget(isCurrent: () => boolean): Promise<void> {
  const state = getAppState();
  const target = getMyUserPreferences(state)?.remoteTargetDeviceId;
  if (target && !getPairedRemoteDeviceById(state, target)) {
    await clearUnavailableRemoteTarget(isCurrent);
  }
}

/** Read opt-in and status after all preceding asynchronous work has settled. */
async function startOptedInReceiver(): Promise<void> {
  const state = getAppState();
  const prefs = getMyUserPreferences(state);
  if (prefs?.remoteReceiverAutoStart && !state.remoteReceiverStatus?.enabled) {
    await startRemoteReceiver(prefs.remoteReceiverPort ?? null);
  }
}

/** Stop continuing a startup chain after its auth session or elevation gate changes. */
export const useRemoteReceiverInit = (
  elevationReady: boolean,
  initReady: boolean,
  authSessionNonce: number,
) => {
  useAsyncEffect(
    async (isCancelled) => {
      const isCurrent = () => {
        const state = getAppState();
        return (
          !isCancelled() &&
          canRunPostElevationInit(elevationReady, initReady) &&
          !state.settings.elevationStartupPending &&
          state.authSessionNonce === authSessionNonce
        );
      };
      if (!isCurrent()) return;
      if (!(await loadPairedRemoteDevices()) || !isCurrent()) return;
      await refreshRemoteReceiverStatus();
      if (!isCurrent()) return;
      await repairMissingTarget(isCurrent);
      if (!isCurrent()) return;
      await startOptedInReceiver();
    },
    [elevationReady, initReady, authSessionNonce],
  );
};
