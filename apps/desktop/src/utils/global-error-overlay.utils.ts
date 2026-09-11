const OVERLAY_ID = "maus-global-error-overlay";

const paintError = (heading: string, detail: string): void => {
  if (typeof document === "undefined") return;
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute(
      "style",
      [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "box-sizing:border-box",
        "background:#0c0c0d",
        "color:#f5f2ed",
        "font:14px/1.6 system-ui,-apple-system,sans-serif",
        "padding:32px",
        "overflow:auto",
        "white-space:pre-wrap",
      ].join(";"),
    );
    if (!document.body) return;
    document.body.appendChild(el);
  }
  el.textContent = `${heading}\n\n${detail}`;
};

const describe = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.message}\n\n${value.stack ?? ""}`;
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

export const paintFatalError = (heading: string, value: unknown): void => {
  paintError(heading, describe(value));
};

export const appHasMounted = (): boolean => {
  if (typeof document === "undefined") return false;
  const root = document.getElementById("root");
  return Boolean(root && root.childNodes.length > 0);
};

const linkIsStylesheet = (link: HTMLLinkElement): boolean => {
  if (link.relList?.contains("stylesheet") === true) {
    return true;
  }
  return link.rel
    .split(/\s+/)
    .some((token) => token.toLowerCase() === "stylesheet");
};

const isFatalResourceTarget = (target: EventTarget | null): boolean => {
  if (target == null) {
    return false;
  }
  const scriptCtor =
    typeof HTMLScriptElement === "undefined" ? undefined : HTMLScriptElement;
  const linkCtor =
    typeof HTMLLinkElement === "undefined" ? undefined : HTMLLinkElement;
  if (scriptCtor != null && target instanceof scriptCtor) {
    return true;
  }
  if (linkCtor != null && target instanceof linkCtor) {
    return linkIsStylesheet(target as HTMLLinkElement);
  }
  return false;
};

export const shouldPaintFatalWindowError = (event: ErrorEvent): boolean => {
  // Once React has mounted, a runtime asset load failure (a <script>/<link>
  // that fails to fetch after the bundle is live — e.g. an async chunk's
  // stylesheet) must not cover a working UI with the fatal overlay. Check the
  // mount state first so post-mount resource errors are logged, not painted.
  if (appHasMounted()) {
    return false;
  }
  if (isFatalResourceTarget(event.target)) {
    return true;
  }
  return Boolean(event.error || event.message);
};

export const shouldPaintFatalRejection = (): boolean => !appHasMounted();

// Resource load failures (<script>/<link> that fail to fetch) dispatch a
// plain `Event`, not an `ErrorEvent`: `event.error` is null and
// `event.message` is undefined. Their `target` is the element, so read the
// failing URL from there to give a useful message.
const describeWindowError = (event: ErrorEvent): string => {
  const target = event.target as EventTarget | null;
  if (isFatalResourceTarget(target)) {
    const url =
      typeof HTMLScriptElement !== "undefined" &&
      target instanceof HTMLScriptElement
        ? target.src
        : (target as HTMLLinkElement).href;
    return `Failed to load resource: ${url || "(unknown URL)"}\n\nThe frontend asset could not be fetched. Under Tauri's asset: protocol this is usually a CORS or path issue — check the built index.html asset URLs.`;
  }
  const message = event.message ?? "";
  return event.error != null ? describe(event.error) : message;
};

// Installed as early as possible so that any failure while the React tree
// mounts (or before it mounts) is shown on screen instead of a blank white
// window. The built frontend can fail to execute under Tauri's asset:
// protocol (e.g. module/CORS load failures) with no visible error otherwise.
//
// After React has mounted, runtime errors and unhandled rejections must not
// cover a working UI with the fatal overlay. Image/media load failures also
// fire capture-phase `error` events and must be ignored.
export const installGlobalErrorOverlay = (): void => {
  if (typeof window === "undefined") return;
  // Re-invocation (hot reload, repeated React remount, test re-run) would
  // register a second pair of listeners and double-log every event. The early
  // inline handlers from index.html are already detached on the first call,
  // so a re-entrant call has nothing left to do.
  if (window.__mausVoiceOverlayInstalled) return;
  window.__mausVoiceOverlayInstalled = true;
  // Detach the inline pre-bundle handler from index.html: from here on this
  // installer owns error surfacing. Leaving the early listener attached would
  // duplicate every unhandledrejection. The property type comes from the
  // global `Window` declaration in vite-env.d.ts.
  const earlyHandler = window.__mausVoiceEarlyUnhandledRejection;
  if (earlyHandler) {
    window.removeEventListener("unhandledrejection", earlyHandler);
    delete window.__mausVoiceEarlyUnhandledRejection;
  }
  const earlyError = window.__mausVoiceEarlyError;
  if (earlyError) {
    window.removeEventListener("error", earlyError, true);
    delete window.__mausVoiceEarlyError;
  }
  // Capture phase: resource load failures (a <script>/<link> that fails to
  // fetch, e.g. a CORS rejection) fire a non-bubbling `error` event, so the
  // bubble-phase listener would never receive them. Capture catches both
  // those and ordinary runtime errors.
  window.addEventListener(
    "error",
    (event) => {
      if (shouldPaintFatalWindowError(event)) {
        paintError("mausVoice failed to start", describeWindowError(event));
        return;
      }
      // Post-mount failures are never fatal. Resource load failures dispatch a
      // plain `Event` with no `error`/`message`, so they are logged here by
      // target rather than falling through the error/message branch below;
      // otherwise a broken async chunk would disappear with no diagnostics.
      if (isFatalResourceTarget(event.target)) {
        console.warn(
          "Ignored post-mount resource load failure",
          describeWindowError(event),
        );
        return;
      }
      if (event.error || event.message) {
        console.error("Ignored post-mount error", event.error ?? event.message);
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    if (!shouldPaintFatalRejection()) {
      console.error("Unhandled rejection after mount", event.reason);
      return;
    }
    paintError("mausVoice failed to start", describe(event.reason));
  });
};
