import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getIntl } from "../i18n/intl";
import { createId } from "./id.utils";

export type ComposerResult = {
  requestId: string;
  accepted: boolean;
  text: string;
};

const COMPOSER_TIMEOUT_MS = 5 * 60 * 1000;

/** Open the local composer popout and wait for its Insert/Cancel decision. */
export const reviewTextInComposer = async (
  text: string,
): Promise<string | null> => {
  const requestId = createId();
  const route = `composer?requestId=${encodeURIComponent(requestId)}`;
  let windowId: string | null = null;
  let unlisten: (() => void) | undefined;
  let unlistenClose: (() => void) | undefined;

  try {
    await invoke("composer_register_text", { requestId, text });
    const result = await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      let timeoutId: number | null = null;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        resolve(value);
      };

      void (async () => {
        try {
          unlisten = await listen<ComposerResult>(
            "composer-result",
            (event) => {
              if (event.payload.requestId !== requestId) return;
              finish(event.payload.accepted ? event.payload.text : null);
            },
          );

          const created = await invoke<{ id: string }>(
            "floating_window_create",
            {
              args: {
                url: "about:blank",
                route,
                title: getIntl().formatMessage({
                  defaultMessage: "Review transcript",
                }),
                width: 560,
                height: 420,
                minWidth: 360,
                minHeight: 280,
                decorations: true,
                resizable: true,
                focused: true,
              },
            },
          );
          windowId = created.id;

          // A user closing the popout is a Cancel decision. Without this
          // listener the caller waits for the five-minute timeout and keeps
          // the dictation/paste flow blocked.
          const composerWindow = await WebviewWindow.getByLabel(created.id);
          if (composerWindow) {
            unlistenClose = await composerWindow.onCloseRequested(() => {
              finish(null);
            });
          }

          timeoutId = window.setTimeout(() => {
            finish(null);
          }, COMPOSER_TIMEOUT_MS);
        } catch (error) {
          reject(error);
        }
      })();
    });
    return result;
  } finally {
    unlisten?.();
    unlistenClose?.();
    await invoke("composer_discard_text", { requestId }).catch(() => {
      // The composer may already have consumed the request.
    });
    if (windowId) {
      await invoke("floating_window_destroy", { id: windowId }).catch(() => {
        // The user may already have closed the popout.
      });
    }
  }
};
