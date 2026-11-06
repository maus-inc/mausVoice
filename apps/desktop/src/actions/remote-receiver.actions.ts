import type { Nullable, RemoteReceiverStatus } from "@maus-inc/types";
import { getRemoteReceiverRepo } from "../repos";
import { produceAppState } from "../store";

let mutationGeneration = 0;
let refreshGeneration = 0;

const setRemoteReceiverStatus = (
  status: Nullable<RemoteReceiverStatus>,
): void => {
  produceAppState((draft) => {
    draft.remoteReceiverStatus = status;
  });
};

export const refreshRemoteReceiverStatus =
  async (): Promise<RemoteReceiverStatus> => {
    const mutation = mutationGeneration;
    const refresh = ++refreshGeneration;
    const status = await getRemoteReceiverRepo().getRemoteReceiverStatus();
    if (mutation === mutationGeneration && refresh === refreshGeneration)
      setRemoteReceiverStatus(status);
    return status;
  };

const updateReceiver = async (
  operation: () => Promise<RemoteReceiverStatus>,
): Promise<RemoteReceiverStatus> => {
  const generation = ++mutationGeneration;
  try {
    const status = await operation();
    if (generation === mutationGeneration) setRemoteReceiverStatus(status);
    return status;
  } finally {
    if (generation === mutationGeneration) mutationGeneration += 1;
  }
};

export const startRemoteReceiver = async (
  port?: number | null,
): Promise<RemoteReceiverStatus> => {
  return updateReceiver(() =>
    getRemoteReceiverRepo().startRemoteReceiver(port),
  );
};

export const stopRemoteReceiver = async (): Promise<RemoteReceiverStatus> => {
  return updateReceiver(() => getRemoteReceiverRepo().stopRemoteReceiver());
};
