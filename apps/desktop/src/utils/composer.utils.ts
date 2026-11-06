import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getIntl } from "../i18n/intl";
import { runToast, showToast } from "../actions/toast.actions";
import { createId } from "./id.utils";
import { requestPillPosition } from "./native-pill.utils";
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

/**
 * If the composer webview never reports `composer-ready`, the user sees a
 * blank page (the reported "white flash" / "killed itself with an error"
 * failure class). Bail out before the full timeout so the caller can fall
 * back to history recovery instead of waiting 5 minutes. The page still
 * has time to mount and call `composer-ready`; the grace period is just a
 * safety net for an unresponsive webview.
 */
const COMPOSER_READY_TIMEOUT_MS = 15_000;

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
 * How long to wait for the pill to answer a geometry request before falling
 * back to the OS placement. The pill replies from its next frame, so this is a
 * safety net for a wedged or non-native overlay, not a pacing delay: the
 * happy path resolves on the `pill-position-changed` event, never on a timer.
 */
const PILL_GEOMETRY_TIMEOUT_MS = 1_000;

type PillPositionEvent = {
  hasSavedPosition: boolean;
  rect?: Rect;
  monitor?: Rect;
};

/**
 * Make sure the pill geometry cache is warm before a window is anchored to it.
 *
 * The native pill publishes `pill-position-changed` only when the user moves
 * it, so the very first review of a session had no geometry to anchor to and
 * the composer opened wherever the OS decided (the reported "composer opens in
 * the centre of the screen" behaviour). Asking the pill to re-publish its
 * geometry closes that gap without waiting for a drag.
 *
 * Returns true when the cache holds a usable rect and monitor. On any failure
 * (no native pill, no answer in time) it logs and returns false, and the
 * caller keeps the OS-chosen placement.
 */
export const ensurePillGeometry = async (): Promise<boolean> => {
  if (cachedPillRect && cachedPillMonitor) return true;

  let unlisten: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    let settle: (published: boolean) => void = () => {};
    const published = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    // Register first, request second: the pill answers immediately and a
    // Tauri event with no listener is dropped, so the reverse order would
    // lose the only reply we get.
    unlisten = await listen<PillPositionEvent>(
      "pill-position-changed",
      (event) => {
        const { rect, monitor } = event.payload;
        if (!rect || !monitor) {
          settle(false);
          return;
        }
        setPillGeometry(rect, monitor);
        settle(true);
      },
    );

    await requestPillPosition();

    const timedOut = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => {
        getLogger().warning(
          "Native pill did not report its geometry in time; using the OS window placement",
        );
        resolve(false);
      }, PILL_GEOMETRY_TIMEOUT_MS);
    });

    return await Promise.race([published, timedOut]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().warning(
      `Could not read the native pill geometry (${message}); using the OS window placement`,
    );
    return false;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    unlisten?.();
  }
};

/** The slot remains owned until settlement cleanup begins, never by a late setup. */
let activeComposer: ComposerReview | null = null;

const destroyComposerWindow = async (id: string): Promise<void> => {
  if (!id) return;
  await invoke("floating_window_destroy", { id }).catch(() => {
    // Closing the window manually can win this race.
  });
};

const releaseComposerListener = (dispose: () => void): void => {
  try {
    void Promise.resolve(dispose()).catch(() => undefined);
  } catch {
    // The native event target may already have gone away during teardown.
  }
};

class ComposerReview {
  readonly requestId = createId();
  windowId = "";
  private settled = false;
  private ready = false;
  private readonly cleanups = new Set<() => void>();
  private setupTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private decisionTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveResult = (_value: string | null): void => {};
  private readonly result = new Promise<string | null>((resolve) => {
    this.resolveResult = resolve;
  });

  constructor(
    private readonly text: string,
    private readonly originalText: string,
  ) {}

  async run(): Promise<string | null> {
    try {
      this.armSetupTimeout();
      await invoke("composer_register_text", {
        requestId: this.requestId,
        text: this.text,
      });
      void this.open().catch((error: unknown) => this.fail(error));
      return await this.result;
    } catch (error: unknown) {
      this.fail(error);
      return await this.result;
    } finally {
      this.finish(null);
      if (activeComposer === this) activeComposer = null;
      for (const dispose of this.cleanups) releaseComposerListener(dispose);
      this.cleanups.clear();
      await invoke("composer_discard_text", {
        requestId: this.requestId,
      }).catch(() => {
        // The composer may already have consumed the request.
      });
      await this.destroyWindow();
    }
  }

  private armSetupTimeout(): void {
    this.setupTimer = setTimeout(() => {
      getLogger().error(
        "reviewTextInComposer: setup timeout (window creation or listener stalled)",
      );
      void this.destroyWindow();
      this.showRecovery();
      this.finish(null);
    }, COMPOSER_READY_TIMEOUT_MS);
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.setupTimer);
    clearTimeout(this.readyTimer);
    clearTimeout(this.decisionTimer);
    this.setupTimer = undefined;
    this.readyTimer = undefined;
    this.decisionTimer = undefined;
    this.resolveResult(value);
  }

  /** A native registration may complete after the result. Dispose it immediately. */
  private retainListener(dispose: () => void): boolean {
    if (this.settled) {
      releaseComposerListener(dispose);
      return false;
    }
    this.cleanups.add(dispose);
    return true;
  }

  private async listen<T>(
    name: string,
    handler: (payload: T) => void,
  ): Promise<boolean> {
    const dispose = await listen<T>(name, ({ payload }) => {
      if (!this.settled) handler(payload);
    });
    return this.retainListener(dispose);
  }

  private windowArgs(): Record<string, unknown> {
    return {
      url: "about:blank",
      route: `composer?requestId=${encodeURIComponent(this.requestId)}&original=${encodeURIComponent(this.originalText)}`,
      title: getIntl().formatMessage({ defaultMessage: "Review transcript" }),
      width: 560,
      height: 420,
      minWidth: 360,
      minHeight: 280,
      decorations: true,
      resizable: true,
      focused: true,
      // Use the cached native pill geometry; omit x/y for OS placement if absent.
      ...getComposerWindowPosition({ width: 560, height: 420 }),
    };
  }

  private async open(): Promise<void> {
    if (
      !(await this.listen<{ requestId: string }>(
        "composer-ready",
        (payload) => {
          if (payload.requestId !== this.requestId) return;
          this.ready = true;
          clearTimeout(this.readyTimer);
          this.readyTimer = undefined;
        },
      ))
    )
      return;
    if (
      !(await this.listen<ComposerResult>("composer-result", (payload) => {
        if (payload.requestId !== this.requestId) return;
        this.finish(payload.accepted ? payload.text : null);
      }))
    )
      return;

    const created = await invoke<{ id: string }>("floating_window_create", {
      args: this.windowArgs(),
    });
    if (this.settled) {
      await destroyComposerWindow(created.id);
      return;
    }
    this.windowId = created.id;
    const composerWindow = await WebviewWindow.getByLabel(created.id);
    if (this.settled) return;
    if (composerWindow) {
      this.retainListener(
        await composerWindow.onCloseRequested(() => this.finish(null)),
      );
    }
    if (this.settled) return;
    clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
    this.armTimeouts();
  }

  private armTimeouts(): void {
    // Readiness can arrive while window creation/lookup is still pending.
    if (!this.ready) {
      this.readyTimer = setTimeout(() => {
        getLogger().error(
          "reviewTextInComposer: composer-ready timeout (webview likely blank)",
        );
        // Do not queue destruction behind an unresponsive text-discard IPC.
        void this.destroyWindow();
        this.showRecovery();
        this.finish(null);
      }, COMPOSER_READY_TIMEOUT_MS);
    }
    this.decisionTimer = setTimeout(
      () => this.finish(null),
      COMPOSER_TIMEOUT_MS,
    );
  }

  private async destroyWindow(): Promise<void> {
    const id = this.windowId;
    this.windowId = "";
    await destroyComposerWindow(id);
  }

  private showRecovery(): void {
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "Could not open the review window. Your transcript was saved to history.",
        }),
        toastType: "error",
        duration: 8000,
        action: "open_transcriptions",
      }),
    );
  }

  private fail(error: unknown): void {
    // A late setup rejection must not toast or disturb a newer review.
    if (this.settled) return;
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error(
      `reviewTextInComposer window creation failed: ${message}`,
    );
    this.showRecovery();
    this.finish(null);
  }
}

/** Review one transcript; resolve edited text or null on cancel/close/failure. */
export const reviewTextInComposer = async (
  text: string,
  options?: { originalText?: string },
): Promise<string | null> => {
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
  const review = new ComposerReview(text, options?.originalText ?? text);
  // Synchronous reservation: two callers cannot both reach native creation.
  activeComposer = review;
  return review.run();
};
