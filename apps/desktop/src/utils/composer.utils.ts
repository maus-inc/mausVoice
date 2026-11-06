import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getIntl } from "../i18n/intl";
import { runToast, showToast } from "../actions/toast.actions";
import { createId } from "./id.utils";
import { composerOriginalRequestId } from "./composer-request-id.utils";
import { requestPillPosition } from "./native-pill.utils";
import { getLogger } from "./log.utils";

type ComposerResult = {
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
  let settled = false;
  let resolveResult!: (published: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (published: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    if (unlisten) releaseComposerListener(unlisten);
    resolveResult(published);
  };
  const timeoutId = setTimeout(() => {
    finish(false);
    try {
      getLogger().warning(
        "Native pill did not report its geometry in time; using the OS window placement",
      );
    } catch {
      // Logging must not defeat the deadline.
    }
  }, PILL_GEOMETRY_TIMEOUT_MS);

  // Register first, request second: a reply sent before a listener is lost.
  // The deadline covers both registration and request IPC, not just the reply.
  void (async () => {
    try {
      const dispose = await listen<PillPositionEvent>(
        "pill-position-changed",
        (event) => {
          if (settled) return;
          const { rect, monitor } = event.payload;
          if (!rect || !monitor) {
            finish(false);
            return;
          }
          setPillGeometry(rect, monitor);
          finish(true);
        },
      );
      if (settled) {
        releaseComposerListener(dispose);
        return;
      }
      unlisten = dispose;
      await requestPillPosition();
    } catch {
      if (settled) return;
      finish(false);
      try {
        getLogger().warning(
          "Could not read the native pill geometry; using the OS window placement",
        );
      } catch {
        // Logging is optional.
      }
    }
  })();
  return result;
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
    private text: string,
    private originalText: string,
    private readonly signal?: AbortSignal,
  ) {}

  async run(): Promise<string | null> {
    const abort = () => this.finish(null);
    if (this.signal?.aborted) {
      this.finish(null);
    } else {
      this.signal?.addEventListener("abort", abort, { once: true });
    }
    if (!this.settled) this.armSetupTimeout();
    // Registration can hang just like window creation. The setup deadline must
    // settle the review even while the native registration has no reply.
    if (!this.settled) void this.prepare().catch(() => this.fail());
    try {
      return await this.result;
    } finally {
      this.signal?.removeEventListener("abort", abort);
      this.finish(null);
      if (activeComposer === this) activeComposer = null;
      for (const dispose of this.cleanups) releaseComposerListener(dispose);
      this.cleanups.clear();
      // Cleanup IPC must not keep the review or the next recording locked. A
      // late registration is discarded again in prepare(), since the first
      // discard may have reached native before registration did.
      void this.discardText(this.requestId);
      void this.discardText(composerOriginalRequestId(this.requestId));
      void this.destroyWindow().catch(() => undefined);
    }
  }

  private async discardText(requestId: string): Promise<void> {
    try {
      await invoke("composer_discard_text", { requestId });
    } catch {
      // The composer may already have consumed the request or be unavailable.
    }
  }

  private async prepare(): Promise<void> {
    await invoke("composer_register_text", {
      requestId: this.requestId,
      text: this.text,
    });
    if (this.settled) {
      void this.discardText(this.requestId);
      return;
    }
    const originalId = composerOriginalRequestId(this.requestId);
    await invoke("composer_register_text", {
      requestId: originalId,
      text: this.originalText,
    });
    if (this.settled) {
      void this.discardText(originalId);
      return;
    }
    await this.open();
  }

  private armSetupTimeout(): void {
    this.setupTimer = setTimeout(() => {
      this.finish(null);
      void this.destroyWindow().catch(() => undefined);
      try {
        getLogger().error(
          "reviewTextInComposer: setup timeout (registration, window creation or listener stalled)",
        );
        this.showRecovery();
      } catch {
        // Feedback is optional; it cannot prevent the deadline from settling.
      }
    }, COMPOSER_READY_TIMEOUT_MS);
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    // A stalled native registration may keep this object alive after the UI
    // has retired; do not retain another copy of the transcript here.
    this.text = "";
    this.originalText = "";
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
      // Transcript text stays in the bounded native handoff, never the URL.
      route: `composer?requestId=${encodeURIComponent(this.requestId)}`,
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
        this.finish(null);
        // Do not queue destruction behind an unresponsive text-discard IPC.
        void this.destroyWindow().catch(() => undefined);
        try {
          getLogger().error(
            "reviewTextInComposer: composer-ready timeout (webview likely blank)",
          );
          this.showRecovery();
        } catch {
          // Feedback is optional; the review has already settled.
        }
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
            "Could not open the review window. The transcript was not inserted.",
        }),
        toastType: "error",
        duration: 8000,
        action: "open_transcriptions",
      }),
    );
  }

  private fail(): void {
    // A late setup rejection must not toast or disturb a newer review.
    if (this.settled) return;
    this.finish(null);
    try {
      // Native errors may contain sensitive transcript text; keep the log generic.
      getLogger().error("reviewTextInComposer setup failed");
      this.showRecovery();
    } catch {
      // Feedback is optional; the review has already settled.
    }
  }
}

/** Review one transcript; resolve edited text or null on cancel/close/failure. */
export const reviewTextInComposer = async (
  text: string,
  options?: { originalText?: string; signal?: AbortSignal },
): Promise<string | null> => {
  if (options?.signal?.aborted) return null;
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
  const review = new ComposerReview(
    text,
    options?.originalText ?? text,
    options?.signal,
  );
  // Synchronous reservation: two callers cannot both reach native creation.
  activeComposer = review;
  return review.run();
};
