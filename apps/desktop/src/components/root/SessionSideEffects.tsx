import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { getAppState, useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";

// 10 minutes
const SESSION_HEARTBEAT_INTERVAL_MS = 1000 * 60 * 10;

type SessionHandle = {
  sessionRef: DatabaseReference;
  sessionName: string;
  listenerUnsubscribe: Unsubscribe | null;
  connectedUnsubscribe: Unsubscribe | null;
  isCurrent: () => boolean;
  lastConsumedTimestamp: number;
};

export const SessionSideEffects = () => {
  // A Firebase session represents the desktop device, not each webview.
  // Popouts must not publish, consume, or remove the main window's session.
  const isMainWindow = getCurrentWindow().label === "main";
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const authSessionNonce = useAppStore((state) => state.authSessionNonce);
  const initialized = useAppStore((state) => state.initialized);
  const sessionHandleRef = useRef<SessionHandle | null>(null);

  useAsyncEffect(
    async (isCancelled) => {
      const isCurrent = () => {
        const state = getAppState();
        return (
          !isCancelled() &&
          isMainWindow &&
          state.initialized &&
          state.auth?.uid === userId &&
          state.authSessionNonce === authSessionNonce
        );
      };
      if (!userId || !isCurrent()) return;

      await refreshRemoteReceiverStatus();
      if (!isCurrent()) return;
      const status = getAppState().remoteReceiverStatus;
      const sessionId = status?.deviceId;
      const sessionName = status?.deviceName ?? "mausVoice Desktop";
      if (!sessionId) return;

      const db = getDatabase();
      const sessionRef = ref(db, `session/${userId}/${sessionId}`);

      await set(sessionRef, {
        name: sessionName,
        lastActive: Date.now(),
      });
      await onDisconnect(sessionRef).remove();

      const handle: SessionHandle = {
        sessionRef,
        sessionName,
        listenerUnsubscribe: null,
        connectedUnsubscribe: null,
        isCurrent,
        lastConsumedTimestamp: Date.now(),
      };

      const connectedRef = ref(db, ".info/connected");
      handle.connectedUnsubscribe = onValue(connectedRef, (snapshot) => {
        if (!isCurrent() || snapshot.val() !== true) return;
        update(sessionRef, { name: sessionName, lastActive: Date.now() }).catch(
          (error) =>
            getLogger().warning(`Session reconnect update failed: ${error}`),
        );
        onDisconnect(sessionRef)
          .remove()
          .catch((error) =>
            getLogger().warning(`onDisconnect re-register failed: ${error}`),
          );
      });

      handle.listenerUnsubscribe = onValue(sessionRef, (snapshot) => {
        if (!isCurrent()) return;
        const data = snapshot.val();
        if (!data?.pasteText || !data?.pasteTimestamp) return;
        if (data.pasteTimestamp <= handle.lastConsumedTimestamp) return;

        handle.lastConsumedTimestamp = data.pasteTimestamp;
        const text = data.pasteText;
        getLogger().info(`Session received paste text (${text.length} chars)`);

        void (async () => {
          await update(sessionRef, { pasteText: null, pasteTimestamp: null });
          // A delayed acknowledgement must not paste into a new account or an
          // unmounted window. The write itself cannot be revoked once dispatched.
          if (!isCurrent()) return;
          await handleRemoteFinalTextReceived(
            {
              senderDeviceId: sessionId,
              eventId: `session-${Date.now()}`,
              text,
              mode: "text",
              createdAt: new Date().toISOString(),
            },
            isCurrent,
          );
        })().catch(() => {
          getLogger().warning("Could not process remote session text");
        });
      });

      sessionHandleRef.current = handle;
      getLogger().info(`Session published: ${sessionId}`);

      return () => {
        sessionHandleRef.current = null;
        handle.listenerUnsubscribe?.();
        handle.connectedUnsubscribe?.();
        void remove(sessionRef).catch((error) => {
          getLogger().warning(`Failed to remove session: ${error}`);
        });
      };
    },
    [initialized, userId, authSessionNonce, isMainWindow],
  );

  useIntervalAsync(SESSION_HEARTBEAT_INTERVAL_MS, async () => {
    const handle = sessionHandleRef.current;
    if (!isMainWindow || !handle || !handle.isCurrent()) return;
    await update(handle.sessionRef, {
      name: handle.sessionName,
      lastActive: Date.now(),
    });
  }, [initialized, userId, authSessionNonce, isMainWindow]);

  return null;
};
