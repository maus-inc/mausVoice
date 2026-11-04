/**
 * ui-capture overlay: draws a simulated mouse, click ripples and a bottom
 * subtitle bar over the page being recorded, so a viewer can see what the
 * pointer did and read what each step was.
 *
 * Installed with page.addInitScript() so it survives navigation and is present
 * before the first frame. All nodes live in one shadow root attached to a host
 * with the highest practical z-index, which keeps the app's CSS and the
 * overlay's CSS from leaking into each other. The overlay is pointer-events
 * none everywhere, so it never intercepts a real click.
 *
 * Every function below is exposed on window.__uicap. The driver in capture.mjs
 * calls window.__uicap.move / click / drag / setSubtitle / hide / destroy via
 * page.evaluate. Nothing here runs on its own except the initial mount.
 */
(() => {
  if (window.__uicap) return;

  const HOST_ID = "__uicap-root";
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  // The shadow root isolates these rules from the app. Design tokens are
  // intentionally NOT used: the overlay must render identically on any page,
  // including the welcome screen and error states, so it ships its own palette.
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .cursor {
      position: fixed; top: 0; left: 0; width: 22px; height: 22px;
      margin: -2px 0 0 -2px; pointer-events: none;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.55));
      transition: none; will-change: transform;
    }
    .cursor svg { display: block; width: 22px; height: 22px; }
    .ring {
      position: fixed; top: 0; left: 0; width: 34px; height: 34px;
      margin: -17px 0 0 -17px; border-radius: 50%;
      border: 2px solid rgba(96,165,250,.9);
      opacity: 0; pointer-events: none; will-change: transform, opacity;
    }
    .ring.pulse { animation: uicap-pulse .55s ease-out forwards; }
    @keyframes uicap-pulse {
      0%   { opacity: .95; transform: scale(.35); }
      100% { opacity: 0;   transform: scale(1.6); }
    }
    .ripple {
      position: fixed; top: 0; left: 0; width: 18px; height: 18px;
      margin: -9px 0 0 -9px; border-radius: 50%;
      background: radial-gradient(circle, rgba(96,165,250,.75) 0%, rgba(96,165,250,0) 70%);
      opacity: 0; pointer-events: none; will-change: transform, opacity;
    }
    .ripple.burst { animation: uicap-burst .6s ease-out forwards; }
    @keyframes uicap-burst {
      0%   { opacity: .9; transform: scale(.4); }
      60%  { opacity: .5; transform: scale(1.9); }
      100% { opacity: 0;  transform: scale(2.6); }
    }
    .subtitle {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      max-width: min(80vw, 960px); padding: 9px 16px;
      font: 500 15px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #f8fafc; background: rgba(9,12,17,.9);
      border: 1px solid rgba(148,163,184,.28); border-radius: 10px;
      text-align: center; letter-spacing: .1px;
      opacity: 0; transition: opacity .18s ease; pointer-events: none;
      white-space: pre-wrap;
    }
    .subtitle.show { opacity: 1; }
    .badge {
      position: fixed; right: 14px; top: 12px; padding: 4px 9px;
      font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .4px;
      color: #cbd5e1; background: rgba(9,12,17,.72);
      border: 1px solid rgba(148,163,184,.24); border-radius: 999px;
      opacity: 0; transition: opacity .18s ease; pointer-events: none;
    }
    .badge.show { opacity: 1; }
  `;

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.innerHTML =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.6 L12 14 L19 14 Z" ' +
    'fill="#f8fafc" stroke="#0b0f14" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  const ring = document.createElement("div");
  ring.className = "ring";
  const ripple = document.createElement("div");
  ripple.className = "ripple";
  const subtitle = document.createElement("div");
  subtitle.className = "subtitle";
  const badge = document.createElement("div");
  badge.className = "badge";

  shadow.append(style, ripple, ring, cursor, subtitle, badge);

  // addInitScript runs before the parser has built <html>, so documentElement
  // can still be null here. Mount now if it exists, otherwise on the first
  // DOM-ready moment, which is still before the first paint of app content.
  const mount = () => {
    if (document.documentElement && !host.isConnected) {
      document.documentElement.appendChild(host);
    }
  };
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  let x = Math.round(window.innerWidth / 2);
  let y = Math.round(window.innerHeight / 2);
  let pressed = false;

  const paintCursor = () => {
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
  const paintRing = () => {
    ring.style.transform = `translate(${x}px, ${y}px)`;
  };

  const flash = (node, cls) => {
    node.classList.remove(cls);
    // Force reflow so the animation restarts on a repeat class toggle.
    void node.offsetWidth;
    node.classList.add(cls);
  };

  const api = {
    /** Teleport the cursor with no trail (use to place it before recording). */
    set(xx, yy) {
      x = xx; y = yy;
      cursor.style.transition = "none";
      paintCursor(); paintRing();
    },
    /** Move the cursor, optionally animating over `ms` via a CSS transition. */
    move(xx, yy, ms = 0) {
      x = xx; y = yy;
      cursor.style.transition = ms > 0 ? `transform ${ms}ms cubic-bezier(.33,.0,.2,1)` : "none";
      paintCursor(); paintRing();
    },
    /** Show the press ring at the current point; pair with up(). */
    down() {
      pressed = true;
      flash(ring, "pulse");
    },
    /** Release and burst a click ripple. */
    up() {
      if (!pressed) flash(ring, "pulse");
      pressed = false;
      flash(ripple, "burst");
    },
    /** Bottom caption bar. Empty string hides it. */
    setSubtitle(text) {
      subtitle.textContent = text || "";
      subtitle.classList.toggle("show", Boolean(text));
    },
    /** Small corner label, e.g. the scenario or build id. */
    setBadge(text) {
      badge.textContent = text || "";
      badge.classList.toggle("show", Boolean(text));
    },
    hide() {
      cursor.style.display = "none";
      ring.style.display = "none";
      ripple.style.display = "none";
    },
    destroy() {
      host.remove();
      delete window.__uicap;
    },
    get point() {
      return { x, y };
    },
  };

  paintCursor();
  paintRing();
  window.__uicap = api;
})();
