import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const earlyErrorScript = indexHtml.match(
  /<script data-early-error>([\s\S]*?)<\/script>/,
)?.[1];

class HTMLScriptElement {
  src = "";
}

class HTMLLinkElement {
  href = "";
  rel = "stylesheet";
  relList = { contains: (token: string) => token === "stylesheet" };
}

type MockElement = {
  id: string;
  textContent: string;
  childNodes: unknown[];
};

const installEarlyOverlay = (rootChildren: unknown[] = []) => {
  const nodes = new Map<string, MockElement>();
  nodes.set("root", {
    id: "root",
    textContent: "",
    childNodes: rootChildren,
  });
  const listeners: Record<string, Array<(event: unknown) => void>> = {
    error: [],
    unhandledrejection: [],
  };
  const body = {
    children: [] as unknown[],
    appendChild(el: unknown) {
      this.children.push(el);
      return el;
    },
  };

  runInNewContext(earlyErrorScript ?? "", {
    HTMLScriptElement,
    HTMLLinkElement,
    document: {
      body,
      documentElement: body,
      getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: (tag: string) => {
        const el = {
          id: "",
          tagName: tag,
          style: { cssText: "" },
          textContent: "",
          childNodes: [] as unknown[],
        };
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
    },
    window: {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners[type] ??= [];
        listeners[type].push(handler);
      },
    } as Record<string, unknown>,
  });

  return { nodes, listeners };
};

describe("early error overlay", () => {
  it("is present in index.html before the module entry", () => {
    expect(earlyErrorScript).toBeTruthy();
    expect(indexHtml.indexOf("data-early-error")).toBeLessThan(
      indexHtml.indexOf('src="/src/main.tsx"'),
    );
  });

  it("paints module-evaluation failures instead of leaving a blank window", () => {
    const { nodes, listeners } = installEarlyOverlay();
    const error = new Error(
      "Cannot read properties of undefined (reading 'Fragment')",
    );
    error.stack = `${error.message}\n    at intl-Bo580dMd.js:22:1847`;

    listeners.error[0]({
      error,
      message: error.message,
      target: {},
    });

    const overlay = nodes.get("maus-global-error-overlay");
    expect(overlay?.textContent).toContain("mausVoice failed to start");
    expect(overlay?.textContent).toContain("Fragment");
    expect(overlay?.textContent).toContain("intl-Bo580dMd.js");
  });

  it("still reports failed script/link fetches", () => {
    const { nodes, listeners } = installEarlyOverlay();
    const script = new HTMLScriptElement();
    script.src = "asset://localhost/assets/index.js";

    listeners.error[0]({
      target: script,
    });

    const overlay = nodes.get("maus-global-error-overlay");
    expect(overlay?.textContent).toContain("Failed to load resource");
    expect(overlay?.textContent).toContain(script.src);

    const link = new HTMLLinkElement();
    link.href = "asset://localhost/assets/styles.css";

    listeners.error[0]({
      target: link,
    });

    const overlayAfterLink = nodes.get("maus-global-error-overlay");
    expect(overlayAfterLink?.textContent).toContain("Failed to load resource");
    expect(overlayAfterLink?.textContent).toContain(link.href);

    const icon = new HTMLLinkElement();
    icon.href = "/app-icon.png";
    icon.rel = "icon";
    icon.relList = { contains: (token: string) => token === "icon" };
    listeners.error[0]({
      target: icon,
    });
    expect(nodes.get("maus-global-error-overlay")?.textContent).not.toContain(
      icon.href,
    );
  });

  it("paints unhandled promise rejections instead of leaving a blank window", () => {
    const { nodes, listeners } = installEarlyOverlay();
    const reason = new Error("async init rejected before React mounted");
    reason.stack = `${reason.message}\n    at main.tsx:10:1`;

    listeners.unhandledrejection[0]({
      reason,
    });

    const overlay = nodes.get("maus-global-error-overlay");
    expect(overlay?.textContent).toContain("mausVoice failed to start");
    expect(overlay?.textContent).toContain(
      "async init rejected before React mounted",
    );
  });

  it("does not paint a fatal runtime-error overlay after React has mounted", () => {
    const { nodes, listeners } = installEarlyOverlay([{}]);

    listeners.error[0]({
      error: new Error("post-mount runtime"),
      message: "post-mount runtime",
      target: {},
    });

    expect(nodes.has("maus-global-error-overlay")).toBe(false);
  });

  it("does not paint a fatal rejection overlay after React has mounted", () => {
    const { nodes, listeners } = installEarlyOverlay([{}]);

    listeners.unhandledrejection[0]({
      reason: new Error("post-mount rejection"),
    });

    expect(nodes.has("maus-global-error-overlay")).toBe(false);
    expect(nodes.get("root")?.childNodes).toHaveLength(1);
  });
});
