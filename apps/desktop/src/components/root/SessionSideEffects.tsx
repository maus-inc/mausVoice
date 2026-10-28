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
import { useRef } from "react";
import { refreshRemoteReceiverStatus } from "../../actions/remote-receiver.actions";
import { handleRemoteFinalTextReceived } from "../../actions/remote-transcript.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { useAppStore } from "../../store";
import {
  beginLocalDataWrite,
  isLocalDataClearRequested,
  withLocalDataWrite,
  type LocalDataWriteLease,
} from "../../utils/local-data-write-gate";
import { getLogger } from "../../utils/log.utils";

// 10 minutes
const SESSION_HEARTBEAT_INTERVAL_MS = 1000 * 60 * 10;

type SessionHandle = {
  sessionRef: DatabaseReference;
  sessionName: string;
  listenerUnsubscribe: Unsubscribe | null;
  connectedUnsubscribe: Unsubscribe | null;
  lastConsumedTimestamp: number;
};

const runSessionWrite = async (
  operation: () => Promise<void>,
  failureMessage: string,
  existingLease?: LocalDataWriteLease,
): Promise<boolean> => {
  try {
    return await withLocalDataWrite(async () => {
      if (isLocalDataClearRequested()) return false;
      await operation();
      return true;
    }, existingLease);
  } catch (error) {
    if (!isLocalDataClearRequested()) {
      getLogger().warning(`${failureMessage}: ${error}`);
    }
    return false;
  }
};

const publishSession = async (
  sessionRef: DatabaseReference,
  sessionName: string,
): Promise<boolean> => {
  try {
    return await withLocalDataWrite(async () => {
      let sessionPublished = false;
      try {
        await set(sessionRef, {
          name: sessionName,
          lastActive: Date.now(),
        });
        sessionPublished = true;

        if (isLocalDataClearRequested()) {
          await remove(sessionRef);
          return false;
        }

        await onDisconnect(sessionRef).remove();
        if (isLocalDataClearRequested()) {
          await remove(sessionRef);
          return false;
        }

        return true;
      } catch (error) {
        if (sessionPublished) {
          await remove(sessionRef).catch((cleanupError: unknown) => {
            getLogger().warning(
              `Failed to remove an incomplete Firebase session: ${cleanupError}`,
            );
          });
        }
        throw error;
      }
    });
  } catch (error) {
    if (!isLocalDataClearRequested()) {
      getLogger().warning(`Failed to publish Firebase session: ${error}`);
    }
    return false;
  }
};

export const SessionSideEffects = () => {
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const initialized = useAppStore((state) => state.initialized);
  const sessionHandleRef = useRef<SessionHandle | null>(null);

  useAsyncEffect(async () => {
    if (!initialized || !userId || isLocalDataClearRequested()) return;

    let status;
    try {
      status = await refreshRemoteReceiverStatus();
    } catch (error) {
      if (!isLocalDataClearRequested()) {
        getLogger().warning(
          `Failed to refresh remote receiver status: ${error}`,
        );
      }
      return;
    }
    if (isLocalDataClearRequested()) return;

    const sessionId = status.deviceId;
    const sessionName = status.deviceName ?? "mausVoice Desktop";
    if (!sessionId) return;

    const db = getDatabase();
    const sessionRef = ref(db, `session/${userId}/${sessionId}`);
    if (!(await publishSession(sessionRef, sessionName))) return;
    if (isLocalDataClearRequested()) return;

    const handle: SessionHandle = {
      sessionRef,
      sessionName,
      listenerUnsubscribe: null,
      connectedUnsubscribe: null,
      lastConsumedTimestamp: Date.now(),
    };

    const connectedRef = ref(db, ".info/connected");
    handle.connectedUnsubscribe = onValue(connectedRef, (snapshot) => {
      if (snapshot.val() !== true || isLocalDataClearRequested()) return;
      void runSessionWrite(async () => {
        await update(sessionRef, { name: sessionName, lastActive: Date.now() });
        if (isLocalDataClearRequested()) return;
        await onDisconnect(sessionRef).remove();
      }, "Session reconnect update failed");
    });

    handle.listenerUnsubscribe = onValue(sessionRef, (snapshot) => {
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
          // A clear may have started while local output and history were saved.
          // Do not start an acknowledgement during that clear, and keep the
          // operation lease until any in-flight Firebase update has settled.
          if (isLocalDataClearRequested()) return;
          await runSessionWrite(
            () => update(sessionRef, { pasteText: null, pasteTimestamp: null }),
            "Failed to consume session paste text",
            releaseWrite.lease,
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
      );
    };
  }, [initialized, userId]);

  useIntervalAsync(SESSION_HEARTBEAT_INTERVAL_MS, async () => {
    const handle = sessionHandleRef.current;
    if (!handle || isLocalDataClearRequested()) return;
    await runSessionWrite(
      () =>
        update(handle.sessionRef, {
          name: handle.sessionName,
          lastActive: Date.now(),
        }),
      "Session heartbeat update failed",
    );
  }, [initialized, userId]);

  return null;
};
