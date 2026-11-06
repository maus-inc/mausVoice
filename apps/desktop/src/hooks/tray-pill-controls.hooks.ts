import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import type { IntlShape } from "react-intl";
import { toggleDictationPillVisibility } from "../actions/user.actions";
import { getAppState } from "../store";
import { ensurePillGeometry, setPillGeometry } from "../utils/composer.utils";
import { getLogger } from "../utils/log.utils";
import {
  getLocalizedPillMenuLabel,
  getPillMenuLabel,
} from "../utils/tray-pill-visibility.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
} from "../utils/user.utils";
import { useTauriListen } from "./tauri.hooks";

/** Main-window ownership of pill tray controls and native geometry. */
export function useTrayPillControls({
  isMainWindow,
  intl,
  visibility,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
  visibility: string | null | undefined;
}) {
  // ── Tray pill-visibility toggle ────────────────────────────────────────────
  // One menu item whose label states the action it performs. The persisted
  // preference is the source of truth; the tray never holds its own toggle.
  const effectivePillVisibility = getEffectivePillVisibility(visibility);

  // Label follows the persisted preference: startup hydration, tray clicks and
  // Settings edits all flow through here, so the tray cannot drift.
  useEffect(() => {
    if (!isMainWindow) return;
    const label = getLocalizedPillMenuLabel(effectivePillVisibility, intl);
    invoke("set_pill_visibility_menu_state", {
      label,
    }).catch(console.error);
  }, [effectivePillVisibility, intl, isMainWindow]);

  useTauriListen<void>("tray-toggle-pill-visibility", () => {
    if (!isMainWindow) return;
    // The action computes its toggle inside the shared preference queue, so
    // a concurrent Settings save cannot make a captured tray value stale.
    void toggleDictationPillVisibility()
      .then(({ previous, next }) => {
        getLogger().info(
          `Tray pill visibility: ${previous} -> ${next} (${getPillMenuLabel(next)})`,
        );
      })
      .catch((error) => {
        getLogger().error(`Failed to toggle pill visibility: ${error}`);
      });
  });

  // ── Tray reset-pill-position ─────────────────────────────────────────────
  // The native pill tracks whether the user has dragged it away from its
  // default centre-bottom spawn. When it reports a position change we sync
  // the tray menu item's enabled state; when the user clicks "Reset Pill
  // Position" we forward the IPC message and the pill re-homes itself.
  useTauriListen<void>("tray-reset-pill-position", () => {
    if (!isMainWindow) return;
    const strategy =
      getMyUserPreferences(getAppState())?.pillResetMonitorStrategy ??
      "current";
    invoke("reset_pill_position", { strategy }).catch((error) => {
      getLogger().error(`Failed to reset pill position: ${error}`);
    });
  });

  // The pill only publishes its geometry when the user moves it, so the first
  // window anchored to it opened wherever the OS decided. Ask once at startup;
  // the `pill-position-changed` listener below caches whatever comes back,
  // even if the pill answers after the request times out.
  useEffect(() => {
    if (!isMainWindow) return;
    ensurePillGeometry().catch((error: unknown) => {
      getLogger().error(`Failed to read the pill geometry: ${error}`);
    });
  }, [isMainWindow]);

  useTauriListen<{
    hasSavedPosition: boolean;
    rect?: { x: number; y: number; width: number; height: number };
    monitor?: { x: number; y: number; width: number; height: number };
  }>("pill-position-changed", (event) => {
    // Pill geometry and tray menu belong to the main window's pill.
    if (!isMainWindow) return;
    setPillGeometry(event.rect ?? null, event.monitor ?? null);
    invoke("set_reset_pill_position_enabled", {
      enabled: event.hasSavedPosition,
    }).catch((error) => {
      getLogger().error(
        `Failed to update reset-pill-position menu state: ${error}`,
      );
    });
  });
}
