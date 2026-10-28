import {
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  set,
  update,
  type DatabaseReference,
  type Unsubscribe,
} from "firebase/database";
import { useEffect, useRef } from "react";
import { refreshRemoteReceiverStatus } from "../../actions/remote-receiver.actions";
import { handleRemoteFinalTextReceived } from "../../actions/remote-transcript.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { useAppStore } from "../../store";
import {
  beginLocalDataWrite,
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import { getLogger } from "../../utils/log.utils";

// 10 minutes
const SESSION_HEARTBEAT_INTERVAL_MS = 1000 * 60 * 10;

type SessionHandle = {
  sessionRef: DatabaseReference;
  sessionName: string;
  clearGeneration: number;
  listenerUnsubscribe: Unsubscribe | null;
  connectedUnsubscribe: Unsubscribe | null;
  lastConsumedTimestamp: number;
};

const isSessionGenerationCurrent = (generation: number): boolean =>
  !isLocalDataClearRequested() && getLocalDataClearGeneration() === generation;

const runSessionWrite = async (
  operation: () => Promise<void>,
  failureMessage: string,
  clearGeneration: number,
): Promise<boolean> => {
  const releaseWrite = beginLocalDataWrite();
  if (!releaseWrite) return false;

  let request: Promise<void>;
  try {
    if (!isSessionGenerationCurrent(clearGeneration)) return false;
    // Firebase may keep this promise pending until it receives a server ack.
    // The local lease covers enqueueing the write, not that network wait; clear
    // listeners remove ephemeral session state if the ack arrives after clear.
    request = operation();
  } catch (error) {
    if (isSessionGenerationCurrent(clearGeneration)) {
      getLogger().warning(`${failureMessage}: ${error}`);
    }
    return false;
  } finally {
    releaseWrite();
  }

  try {
    await request;
    return isSessionGenerationCurrent(clearGeneration);
  } catch (error) {
    if (isSessionGenerationCurrent(clearGeneration)) {
      getLogger().warning(`${failureMessage}: ${error}`);
    }
    return false;
  }
};

const publishSession = async (
  sessionRef: DatabaseReference,
  sessionName: string,
  clearGeneration: number,
): Promise<boolean> => {
  const published = await runSessionWrite(
    () =>
      set(sessionRef, {
        name: sessionName,
        lastActive: Date.now(),
      }),
    "Failed to publish Firebase session",
    clearGeneration,
  );
  if (!published) {
    if (isSessionGenerationCurrent(clearGeneration)) {
      await runSessionWrite(
        () => remove(sessionRef),
        "Failed to remove an incomplete Firebase session",
        clearGeneration,
      );
    }
    return false;
  }

  if (!isSessionGenerationCurrent(clearGeneration)) return false;
  const disconnectRegistered = await runSessionWrite(
    () => onDisconnect(sessionRef).remove(),
    "Failed to register Firebase session cleanup",
    clearGeneration,
  );
  if (!disconnectRegistered && isSessionGenerationCurrent(clearGeneration)) {
    await runSessionWrite(
      () => remove(sessionRef),
      "Failed to remove an incomplete Firebase session",
      clearGeneration,
    );
  }
  return disconnectRegistered && isSessionGenerationCurrent(clearGeneration);
};

export const SessionSideEffects = () => {
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const initialized = useAppStore((state) => state.initialized);
  const sessionHandleRef = useRef<SessionHandle | null>(null);
  const pendingSessionRef = useRef<DatabaseReference | null>(null);

  useEffect(
    () =>
      subscribeToLocalDataClearRequested(() => {
        const handle = sessionHandleRef.current;
        const sessionRef = handle?.sessionRef ?? pendingSessionRef.current;
        sessionHandleRef.current = null;
        pendingSessionRef.current = sessionRef;
        handle?.listenerUnsubscribe?.();
        handle?.connectedUnsubscribe?.();

        if (sessionRef) {
          // A Firebase write may still be waiting for its server ack. Queue a
          // compensating removal immediately; it follows any already-enqueued
          // session write and does not hold the local clear drain open. Retain a
          // failed removal so a destructive-clear retry can enqueue it again.
          remove(sessionRef)
            .then(() => {
              if (pendingSessionRef.current === sessionRef) {
                pendingSessionRef.current = null;
              }
            })
            .catch((error: unknown) => {
              getLogger().warning(
                `Failed to remove session while clearing: ${error}`,
              );
            });
        }
      }),
    [],
  );

  useAsyncEffect(async () => {
    const clearGeneration = getLocalDataClearGeneration();
    if (
      !initialized ||
      !userId ||
      !isSessionGenerationCurrent(clearGeneration)
    ) {
      return;
    }

    let status;
    try {
      status = await refreshRemoteReceiverStatus();
    } catch (error) {
      if (isSessionGenerationCurrent(clearGeneration)) {
        getLogger().warning(
          `Failed to refresh remote receiver status: ${error}`,
        );
      }
      return;
    }
    if (!isSessionGenerationCurrent(clearGeneration)) return;

    const sessionId = status.deviceId;
    const sessionName = status.deviceName ?? "mausVoice Desktop";
    if (!sessionId) return;

    const db = getDatabase();
    const sessionRef = ref(db, `session/${userId}/${sessionId}`);
    pendingSessionRef.current = sessionRef;
    if (!(await publishSession(sessionRef, sessionName, clearGeneration))) {
      if (pendingSessionRef.current === sessionRef) {
        pendingSessionRef.current = null;
      }
      return;
    }
    if (!isSessionGenerationCurrent(clearGeneration)) {
      if (pendingSessionRef.current === sessionRef) {
        pendingSessionRef.current = null;
      }
      return;
    }

    const handle: SessionHandle = {
      sessionRef,
      sessionName,
      clearGeneration,
      listenerUnsubscribe: null,
      connectedUnsubscribe: null,
      lastConsumedTimestamp: Date.now(),
    };

    const connectedRef = ref(db, ".info/connected");
    handle.connectedUnsubscribe = onValue(connectedRef, (snapshot) => {
      if (
        snapshot.val() !== true ||
        !isSessionGenerationCurrent(handle.clearGeneration)
      ) {
        return;
      }
      void runSessionWrite(
        async () => {
          await update(sessionRef, {
            name: sessionName,
            lastActive: Date.now(),
          });
          if (!isSessionGenerationCurrent(handle.clearGeneration)) return;
          await onDisconnect(sessionRef).remove();
        },
        "Session reconnect update failed",
        handle.clearGeneration,
      );
    });

    handle.listenerUnsubscribe = onValue(sessionRef, (snapshot) => {
      if (!isSessionGenerationCurrent(handle.clearGeneration)) return;
      const data = snapshot.val();
      if (!data?.pasteText || !data?.pasteTimestamp) return;
      if (data.pasteTimestamp <= handle.lastConsumedTimestamp) return;

      const releaseWrite = beginLocalDataWrite();
      if (!releaseWrite) return;

      const previousConsumedTimestamp = handle.lastConsumedTimestamp;
      handle.lastConsumedTimestamp = data.pasteTimestamp;
      const text = data.pasteText;

      getLogger().info(`Session received paste text (${text.length} chars)`);

      handleRemoteFinalTextReceived(
        {
          senderDeviceId: sessionId,
          eventId: `session-${data.pasteTimestamp}`,
          text,
          mode: "text",
          createdAt: new Date().toISOString(),
        },
        releaseWrite.lease,
      )
        .then(async () => {
          // The local action lease ends with local output/history persistence.
          // The remote ack gets only a short enqueue lease, so an offline Firebase
          // response cannot hold the local clear drain open.
          releaseWrite();
          if (!isSessionGenerationCurrent(handle.clearGeneration)) return;
          await runSessionWrite(
            () => update(sessionRef, { pasteText: null, pasteTimestamp: null }),
            "Failed to consume session paste text",
            handle.clearGeneration,
          );
        })
        .catch((error: unknown) => {
          if (handle.lastConsumedTimestamp === data.pasteTimestamp) {
            handle.lastConsumedTimestamp = previousConsumedTimestamp;
          }
          getLogger().warning(`Failed to process session paste text: ${error}`);
        })
        .finally(releaseWrite);
    });

    sessionHandleRef.current = handle;
    pendingSessionRef.current = null;
    getLogger().info(`Session published: ${sessionId}`);

    return () => {
      sessionHandleRef.current = null;
      handle.listenerUnsubscribe?.();
      handle.connectedUnsubscribe?.();
      // The disconnect handler covers a clear or interrupted shutdown. Normal
      // teardown removes the ephemeral session while holding a short lease.
      void runSessionWrite(
        () => remove(sessionRef),
        "Failed to remove session",
        handle.clearGeneration,
      );
    };
  }, [initialized, userId]);

  useIntervalAsync(SESSION_HEARTBEAT_INTERVAL_MS, async () => {
    const handle = sessionHandleRef.current;
    if (!handle || !isSessionGenerationCurrent(handle.clearGeneration)) return;
    await runSessionWrite(
      () =>
        update(handle.sessionRef, {
          name: handle.sessionName,
          lastActive: Date.now(),
        }),
      "Session heartbeat update failed",
      handle.clearGeneration,
    );
  }, [initialized, userId]);

  return null;
};
