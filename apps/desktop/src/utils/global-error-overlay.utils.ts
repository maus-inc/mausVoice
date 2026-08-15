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

// Resource load failures (<script>/<link> that fail to fetch) dispatch a
// plain `Event`, not an `ErrorEvent`: `event.error` is null and
// `event.message` is undefined. Their `target` is the element, so read the
// failing URL from there to give a useful message.
const describeWindowError = (event: ErrorEvent): string => {
  const target = event.target as EventTarget | null;
  if (
    target instanceof HTMLScriptElement ||
    target instanceof HTMLLinkElement
  ) {
    const url = target instanceof HTMLScriptElement ? target.src : target.href;
    return `Failed to load resource: ${url || "(unknown URL)"}\n\nThe frontend asset could not be fetched. Under Tauri's asset: protocol this is usually a CORS or path issue — check the built index.html asset URLs.`;
  }
  const message = event.message ?? "";
  return event.error != null ? describe(event.error) : message;
};

// Installed as early as possible so that any failure while the React tree
// mounts (or before it mounts) is shown on screen instead of a blank white
// window. The built frontend can fail to execute under Tauri's asset:
// protocol (e.g. module/CORS load failures) with no visible error otherwise.
export const installGlobalErrorOverlay = (): void => {
  if (typeof window === "undefined") return;
  // Capture phase: resource load failures (a <script>/<link> that fails to
  // fetch, e.g. a CORS rejection) fire a non-bubbling `error` event, so the
  // bubble-phase listener would never receive them. Capture catches both
  // those and ordinary runtime errors.
  window.addEventListener(
    "error",
    (event) => {
      paintError("mausVoice failed to start", describeWindowError(event));
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    paintError("mausVoice failed to start", describe(event.reason));
  });
};
