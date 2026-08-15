import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
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
  const route = `composer?requestId=${encodeURIComponent(requestId)}&text=${encodeURIComponent(text)}`;
  let windowId: string | null = null;
  let unlisten: (() => void) | undefined;

  try {
    const result = await new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      void (async () => {
        unlisten = await listen<ComposerResult>("composer-result", (event) => {
          if (event.payload.requestId !== requestId) return;
          finish(event.payload.accepted ? event.payload.text : null);
        });

        try {
          const created = await invoke<{ id: string }>(
            "floating_window_create",
            {
              args: {
                url: "about:blank",
                route,
                title: "Review transcript",
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
        } catch (error) {
          reject(error);
          return;
        }

        window.setTimeout(() => {
          if (!settled) {
            finish(null);
          }
        }, COMPOSER_TIMEOUT_MS);
      })();
    });
    return result;
  } finally {
    const cleanup = unlisten;
    if (cleanup) cleanup();
    if (windowId) {
      await invoke("floating_window_destroy", { id: windowId }).catch(() => {
        // The user may already have closed the popout.
      });
    }
  }
};
