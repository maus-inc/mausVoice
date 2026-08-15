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
      const detail =
        event.error != null ? describe(event.error) : event.message;
      paintError("mausVoice failed to start", String(detail));
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    paintError("mausVoice failed to start", describe(event.reason));
  });
};
