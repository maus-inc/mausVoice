import { afterEach, describe, expect, it, vi } from "vitest";

const overlayId = "maus-global-error-overlay";

const makeDocument = (rootChildren: unknown[] = []) => {
  const nodes = new Map<
    string,
    { id: string; childNodes: unknown[]; textContent: string }
  >();
  nodes.set("root", { id: "root", childNodes: rootChildren, textContent: "" });
  const body = {
    appendChild(el: { id: string }) {
      nodes.set(el.id, el as never);
      return el;
    },
  };
  return {
    body,
    getElementById: (id: string) => nodes.get(id) ?? null,
    createElement: () => {
      const el = { id: "", textContent: "", childNodes: [] as unknown[] };
      return new Proxy(el, {
        set(target, prop, value) {
          (target as Record<string | symbol, unknown>)[prop] = value;
          if (prop === "id" && typeof value === "string") {
            nodes.set(value, target);
          }
          return true;
        },
      });
    },
    nodes,
  };
};

describe("global error overlay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not treat a mounted app's unhandled rejection as a failed start", async () => {
    const doc = makeDocument([{}]);
    vi.stubGlobal("document", doc);
    const { shouldPaintFatalRejection, appHasMounted } =
      await import("./global-error-overlay.utils.ts");
    expect(appHasMounted()).toBe(true);
    expect(shouldPaintFatalRejection()).toBe(false);
  });

  it("paints unhandled rejections only before React mounts", async () => {
    const doc = makeDocument([]);
    vi.stubGlobal("document", doc);
    const { shouldPaintFatalRejection } =
      await import("./global-error-overlay.utils.ts");
    expect(shouldPaintFatalRejection()).toBe(true);
  });

  it("treats failed script and stylesheet loads as fatal before mount", async () => {
    vi.stubGlobal("document", makeDocument([]));
    class HTMLScriptElement {
      src = "asset://localhost/assets/index.js";
    }
    class HTMLLinkElement {
      href = "asset://localhost/assets/styles.css";
      rel = "StyleSheet";
      relList = {
        contains: (_token: string): boolean => false,
      };
    }
    vi.stubGlobal("HTMLScriptElement", HTMLScriptElement);
    vi.stubGlobal("HTMLLinkElement", HTMLLinkElement);
    const { shouldPaintFatalWindowError } =
      await import("./global-error-overlay.utils.ts");
    expect(
      shouldPaintFatalWindowError({
        target: new HTMLScriptElement(),
      } as unknown as ErrorEvent),
    ).toBe(true);
    expect(
      shouldPaintFatalWindowError({
        target: new HTMLLinkElement(),
      } as unknown as ErrorEvent),
    ).toBe(true);
    // A non-stylesheet <link> (e.g. an icon) is not a fatal resource target.
    const icon = new HTMLLinkElement();
    icon.rel = "icon";
    icon.relList = {
      contains: (token: string): boolean => token === "icon",
    };
    expect(
      shouldPaintFatalWindowError({
        target: icon,
      } as unknown as ErrorEvent),
    ).toBe(false);
  });

  it("does not treat a post-mount failed stylesheet/script load as fatal", async () => {
    // Once React has mounted, an async chunk's stylesheet/script can still fail
    // to load; that must log, not cover a working UI with the fatal overlay.
    vi.stubGlobal("document", makeDocument([{}]));
    class HTMLScriptElement {
      src = "asset://localhost/assets/index.js";
    }
    class HTMLLinkElement {
      href = "asset://localhost/assets/styles.css";
      rel = "StyleSheet";
      relList = {
        contains: (_token: string): boolean => false,
      };
    }
    vi.stubGlobal("HTMLScriptElement", HTMLScriptElement);
    vi.stubGlobal("HTMLLinkElement", HTMLLinkElement);
    const { shouldPaintFatalWindowError } =
      await import("./global-error-overlay.utils.ts");
    expect(
      shouldPaintFatalWindowError({
        target: new HTMLScriptElement(),
      } as unknown as ErrorEvent),
    ).toBe(false);
    expect(
      shouldPaintFatalWindowError({
        target: new HTMLLinkElement(),
      } as unknown as ErrorEvent),
    ).toBe(false);
  });

  it("ignores image load failures and post-mount runtime errors", async () => {
    vi.stubGlobal("document", makeDocument([{}]));
    class HTMLImageElement {}
    vi.stubGlobal("HTMLImageElement", HTMLImageElement);
    const { shouldPaintFatalWindowError } =
      await import("./global-error-overlay.utils.ts");
    expect(
      shouldPaintFatalWindowError({
        target: new HTMLImageElement(),
        error: null,
        message: "",
      } as unknown as ErrorEvent),
    ).toBe(false);
    expect(
      shouldPaintFatalWindowError({
        target: {},
        error: new Error("ResizeObserver loop"),
        message: "ResizeObserver loop",
      } as unknown as ErrorEvent),
    ).toBe(false);
  });

  it("paints pre-mount runtime errors", async () => {
    vi.stubGlobal("document", makeDocument([]));
    const { shouldPaintFatalWindowError } =
      await import("./global-error-overlay.utils.ts");
    expect(
      shouldPaintFatalWindowError({
        target: {},
        error: new Error("Cannot read Fragment"),
        message: "Cannot read Fragment",
      } as unknown as ErrorEvent),
    ).toBe(true);
  });

  it("logs a post-mount resource load failure instead of dropping it", async () => {
    const doc = makeDocument([{}]);
    vi.stubGlobal("document", doc);
    class HTMLScriptElement {
      src = "asset://localhost/assets/async-chunk.js";
    }
    class HTMLLinkElement {
      href = "asset://localhost/assets/async-chunk.css";
      rel = "StyleSheet";
      relList = {
        contains: (_token: string): boolean => false,
      };
    }
    vi.stubGlobal("HTMLScriptElement", HTMLScriptElement);
    vi.stubGlobal("HTMLLinkElement", HTMLLinkElement);
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] ??= [];
        listeners[type].push(handler);
      },
      removeEventListener: () => {},
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { installGlobalErrorOverlay } =
      await import("./global-error-overlay.utils.ts");
    installGlobalErrorOverlay();
    // A resource load failure dispatches a plain Event with no error/message.
    listeners.error[0]({
      target: new HTMLScriptElement(),
    });
    expect(doc.getElementById(overlayId)).toBeNull();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("does not log ignored image load failures", async () => {
    const doc = makeDocument([{}]);
    vi.stubGlobal("document", doc);
    class HTMLImageElement {}
    vi.stubGlobal("HTMLImageElement", HTMLImageElement);
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] ??= [];
        listeners[type].push(handler);
      },
      removeEventListener: () => {},
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { installGlobalErrorOverlay } =
      await import("./global-error-overlay.utils.ts");
    installGlobalErrorOverlay();
    listeners.error[0]({
      target: new HTMLImageElement(),
      error: null,
      message: "",
    });
    expect(doc.getElementById(overlayId)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not create an overlay for post-mount rejections", async () => {
    const doc = makeDocument([{}]);
    vi.stubGlobal("document", doc);
    const listeners: Record<string, Array<(event: unknown) => void>> = {};
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] ??= [];
        listeners[type].push(handler);
      },
      removeEventListener: () => {},
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { installGlobalErrorOverlay } =
      await import("./global-error-overlay.utils.ts");
    installGlobalErrorOverlay();
    listeners.unhandledrejection[0]({
      reason: new Error("sidecar timeout"),
    });
    expect(doc.getElementById(overlayId)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
