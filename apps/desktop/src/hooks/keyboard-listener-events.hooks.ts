import { getRec } from "@maus-inc/utilities";
import { useRef } from "react";
import type { IntlShape } from "react-intl";
import { showSnackbar } from "../actions/app.actions";
import { restartKeyboardListenerOnResume } from "../actions/windows-sync.actions";
import type { KeyboardListenerHealth } from "../state/app.state";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { isPermissionAuthorized } from "../utils/permission.utils";
import { useTauriListen } from "./tauri.hooks";

type KeyboardListenerHealthPayload = { state: KeyboardListenerHealth };

/** Reflect native listener health and request a guarded restart after resume. */
export function useKeyboardListenerEvents({
  isMainWindow,
  intl,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
}) {
  const listenerFailureNotifiedRef = useRef(false);
  // Surface listener health (grounded in the child's actual grab/listen outcome). Rust owns
  // automatic recovery; TS only reflects state here and exposes a manual retry elsewhere — it
  // must not auto-restart the listener on "failed".
  useTauriListen<KeyboardListenerHealthPayload>(
    "keyboard_listener_health",
    (payload) => {
      if (getAppState().keyboardListenerHealth === payload.state) {
        return;
      }
      // Reset the failure notification once the listener genuinely recovers, so a later
      // failure episode can notify again.
      if (
        payload.state === "healthy_grab" ||
        payload.state === "degraded_listen_fallback"
      ) {
        listenerFailureNotifiedRef.current = false;
      }
      if (payload.state === "failed" && !listenerFailureNotifiedRef.current) {
        listenerFailureNotifiedRef.current = true;
        getLogger().warning("Keyboard listener reported failed health");
        const authorized = isPermissionAuthorized(
          getRec(getAppState().permissions, "accessibility")?.state,
        );
        if (authorized) {
          showSnackbar(
            intl.formatMessage({
              defaultMessage:
                "Keyboard hotkeys stopped working. Retrying automatically; restart mausVoice if this persists.",
            }),
            { mode: "error", duration: 6000 },
          );
        }
      }
      produceAppState((draft) => {
        draft.keyboardListenerHealth = payload.state;
      });
    },
  );

  // A23 (Windows): rdev's low-level hook is torn down across sleep/wake and
  // session-unlock. The Rust lifecycle watcher emits `desktop_resume`; this
  // listener is the frontend half of that handshake and re-grabs the hook.
  // State is read at fire time so a stale closure can never restart the
  // listener after the strategy or permission flips.
  useTauriListen<void>("desktop_resume", () => {
    const resumeState = getAppState();
    restartKeyboardListenerOnResume({
      hotkeyStrategy: resumeState.hotkeyStrategy,
      isMainWindow,
      keyPermAuthorized: isPermissionAuthorized(
        getRec(resumeState.permissions, "accessibility")?.state,
      ),
    })
      .then((restarted) => {
        if (restarted) {
          getLogger().info("Restarted keyboard listener after desktop resume");
        }
      })
      .catch((error: unknown) => {
        getLogger().warning(
          `Failed to restart keyboard listener after desktop resume: ${error}`,
        );
      });
  });
}
