import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getIntl } from "../i18n/intl";
import { showToast } from "../actions/toast.actions";
import { createId } from "./id.utils";
import { getLogger } from "./log.utils";

export type ComposerResult = {
  requestId: string;
  accepted: boolean;
  text: string;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Size = {
  width: number;
  height: number;
};

const COMPOSER_TIMEOUT_MS = 5 * 60 * 1000;

// Gap (logical px) kept between the native pill and the composer window so the
// composer never overlaps the pill.
const COMPOSER_PILL_GAP = 8;

/**
 * Compute the top-left position of the composer window so it sits adjacent to
 * the native dictation pill and stays fully within the given monitor.
 *
 * Preference order for the anchor side: below the pill (left-aligned), then to
 * the right (top-aligned), then to the left (top-aligned), then above (left-
 * aligned). If none of those fit without overflowing, it falls back to below
 * and clamps into the monitor bounds.
 *
 * All inputs may use negative coordinates (multi-monitor setups where a monitor
 * lives at e.g. x=-1920), and the returned position is always clamped to the
 * monitor rectangle so the composer is never placed off-screen.
 */
export const computeComposerRect = (
  pillRect: Rect,
  composerSize: Size,
  monitor: Rect,
): { x: number; y: number } => {
  const { width: composerWidth, height: composerHeight } = composerSize;
  const gap = COMPOSER_PILL_GAP;

  const monitorLeft = monitor.x;
  const monitorTop = monitor.y;
  const monitorRight = monitor.x + monitor.width;
  const monitorBottom = monitor.y + monitor.height;

  const candidates: Array<{ x: number; y: number }> = [
    { x: pillRect.x, y: pillRect.y + pillRect.height + gap },
    { x: pillRect.x + pillRect.width + gap, y: pillRect.y },
    { x: pillRect.x - gap - composerWidth, y: pillRect.y },
    { x: pillRect.x, y: pillRect.y - gap - composerHeight },
  ];

  const fitsOnMonitor = (x: number, y: number): boolean =>
    x >= monitorLeft &&
    y >= monitorTop &&
    x + composerWidth <= monitorRight &&
    y + composerHeight <= monitorBottom;

  const chosen =
    candidates.find((c) => fitsOnMonitor(c.x, c.y)) ?? candidates[0];

  // Clamp the chosen origin fully inside the monitor. When the composer is
  // wider/taller than the monitor, the upper bound falls below the lower bound;
  // in that case anchor the origin at the monitor's left/top edge so the window
  // is never placed with its origin off-screen (see handbook 3.7).
  const clampInside = (
    value: number,
    min: number,
    maxExclusive: number,
  ): number => {
    const upper = Math.max(min, maxExclusive);
    return Math.min(Math.max(value, min), upper);
  };

  const clampedX = clampInside(
    chosen.x,
    monitorLeft,
    monitorRight - composerWidth,
  );
  const clampedY = clampInside(
    chosen.y,
    monitorTop,
    monitorBottom - composerHeight,
  );

  return { x: clampedX, y: clampedY };
};

// Last known native pill geometry and the monitor it lives on. Populated from
// the `pill-position-changed` event (which the native overlay emits with the
// pill rect/monitor once available). When unset the composer falls back to the
// OS-chosen (centered) placement.
let cachedPillRect: Rect | null = null;
let cachedPillMonitor: Rect | null = null;

export const setPillGeometry = (
  rect: Rect | null,
  monitor: Rect | null,
): void => {
  cachedPillRect = rect;
  cachedPillMonitor = monitor;
};

/** Position the composer next to the pill, or null to use the OS default. */
export const getComposerWindowPosition = (
  composerSize: Size,
): { x: number; y: number } | null => {
  if (!cachedPillRect || !cachedPillMonitor) return null;
  return computeComposerRect(cachedPillRect, composerSize, cachedPillMonitor);
};

/**
 * Tracks the currently open review window, if any. The paste/output path
 * awaits one review at a time, but a second dictation or a stale caller can
 * race; reusing the live window prevents a broken duplicate WebView2 window
 * (the Windows "white flash then vanishes" failure class).
 */
let activeComposer: { windowId: string; requestId: string } | null = null;

/** Open the local composer popout and wait for its Insert/Cancel decision. */
export const reviewTextInComposer = async (
  text: string,
): Promise<string | null> => {
  // If a review is already in flight, focus its window best-effort and do
  // not open a second WebView2 window. The guard is set synchronously at
  // entry (before any await) so a racing second dictation cannot slip
  // through while the first window is still being created.
  if (activeComposer) {
    if (activeComposer.windowId) {
      WebviewWindow.getByLabel(activeComposer.windowId)
        .then((existing) => existing?.setFocus())
        .catch(() => undefined);
    }
    getLogger().warning(
      "reviewTextInComposer: a composer window is already open; focusing it",
    );
    return null;
  }

  const requestId = createId();
  const route = `composer?requestId=${encodeURIComponent(requestId)}`;
  let windowId: string | null = null;
  let unlisten: (() => void) | undefined;
  let unlistenClose: (() => void) | undefined;

  // Reserve the slot synchronously so concurrent calls are rejected.
  activeComposer = { windowId: "", requestId };

  try {
    await invoke("composer_register_text", { requestId, text });
    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      let timeoutId: number | null = null;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        activeComposer = null;
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

          const args: Record<string, unknown> = {
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
          };

          // The composer is a Tauri webview window, but the dictation pill is a
          // separate native process (not a WebviewWindow), so there is no
          // "pill" window label to query for its position. Instead we anchor to
          // the pill's geometry via the `pill-position-changed` event
          // (forwarded into `setPillGeometry`). When the pill geometry is known
          // we place the composer adjacent to the pill; otherwise we omit
          // x/y and let the OS choose a centered position.

          const composerPosition = getComposerWindowPosition({
            width: args.width as number,
            height: args.height as number,
          });
          if (composerPosition) {
            args.x = composerPosition.x;
            args.y = composerPosition.y;
          }

          const created = await invoke<{ id: string }>(
            "floating_window_create",
            {
              args,
            },
          );
          windowId = created.id;
          activeComposer = { windowId: created.id, requestId };

          // A second transcript while a composer is open must not create a
          // broken duplicate window. If a composer window already exists the
          // caller (the paste tool) runs one review at a time and awaits it,
          // so reaching here means no live review is pending; we still guard
          // against a stale label by focusing the created window.

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
          // WebView2 creation failure (the Windows "white flash then
          // disappears" report). Do NOT silently fall back to insertion
          // when review-before-insert is enabled: return null so the caller
          // skips insertion and keeps the transcript in history. The Rust
          // command already logged a sanitized error with the window label.
          const message =
            error instanceof Error ? error.message : String(error);
          getLogger().error(
            `reviewTextInComposer window creation failed: ${message}`,
          );
          // Surface a visible recovery action: the transcript was retained
          // in history, and the "Open history" button brings the main
          // window to the transcriptions list so the user does not lose it.
          void showToast({
            message: getIntl().formatMessage({
              defaultMessage:
                "Could not open the review window. Your transcript was saved to history.",
            }),
            toastType: "error",
            duration: 8000,
            action: "open_transcriptions",
          });
          finish(null);
        }
      })();
    });
    return result;
  } finally {
    activeComposer = null;
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
