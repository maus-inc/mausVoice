import { getBrowserRouter } from "../router";
import { produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { surfaceMainWindow } from "../utils/window.utils";
import { useToastAction } from "./toast.hooks";

/** Surface the main window and route actionable toast clicks. */
export function useAppToastNavigation() {
  useToastAction((payload) => {
    if (payload.action === "open_agent_settings") {
      // `surfaceMainWindow` swallows its own errors and coalesces concurrent
      // calls, so there is nothing to await or recover from here: surfacing is a
      // side effect, and the dialog state below must not wait on the IPC.
      void surfaceMainWindow();
      produceAppState((draft) => {
        draft.settings.agentModeDialogOpen = true;
      });
    } else if (payload.action === "surface_window") {
      void surfaceMainWindow();
    } else if (payload.action === "open_transcriptions") {
      // `getBrowserRouter()` lazily builds the router and is documented as safe
      // before Router mounts, so navigating does not depend on the window being
      // up. `navigate` returns a promise that a synchronous try/catch cannot
      // catch, so the rejection is handled on the promise itself.
      void surfaceMainWindow();
      try {
        void getBrowserRouter()
          .navigate("/dashboard/transcriptions")
          .catch((error: unknown) => {
            getLogger().warning(
              `Failed to navigate to transcriptions: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      } catch (error) {
        getLogger().warning(
          `Failed to build the router: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
}
